import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import {
  AGGREGATIONS,
  CHART_KINDS,
  EXPORT_FORMATS,
  SCHEDULE_INTERVALS,
  type Chart,
  type ChartConfig,
  type ExportFormat,
  type FieldError,
  type ParamValues,
  type PivotConfig,
  type Report,
  type ReportParam,
  type Schedule,
} from '../shared/types.js';
import {
  accessOf,
  actorOf,
  checkCredentials,
  clearedCookie,
  createEmbedToken,
  createToken,
  requireAuth,
  sessionCookie,
  verifyEmbedToken,
  type AuthConfig,
} from './auth.js';
import { createHandoff, isRedeemPath, requestedAccess, safeServiceTokenEqual } from './handoff.js';
import { parseSummaryContext } from '../shared/summary.js';
import { moduleSummary } from './summary.js';
import { renderChartSvg } from './charts.js';
import { resultToCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { LOCAL_LOGIN, nullVerifier, type LoginMode, type LoginVerifier } from './sso.js';
import { DomainError, nowIso } from './errors.js';
import { computePivot } from './pivot.js';
import { checkReportSql, QUERY_POLICY, type PolicyOptions } from './query-policy.js';
import { currentValues, executeRun, type RunContext } from './runs.js';
import { nextDueAt } from './scheduler.js';
import { describeSource, runReportQuery, sourcePolicy } from './source-db.js';
import { parseParamDefs, parseParamValues, resolveParams, validateParamDefs, validateParamValues } from './params.js';
import { readSettings, writeSettings } from './settings.js';
import { buildXlsx, pivotSheet, resultSheet } from './xlsx.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// ── Tiny validation helpers ────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function fail(details: FieldError[]): never {
  throw new DomainError(422, 'Validation failed', details);
}

function reqText(raw: unknown, field: string, errors: FieldError[], maxLength: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.length > maxLength) {
    errors.push({ field, message: `${field} is required (max ${maxLength} characters)` });
  }
  return text;
}

function optText(raw: unknown, field: string, errors: FieldError[], maxLength: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be a string` });
    return null;
  }
  const text = raw.trim();
  if (text.length > maxLength) errors.push({ field, message: `${field} must be at most ${maxLength} characters` });
  return text === '' ? null : text;
}

type ReportRow = Omit<Report, 'params'> & { params: string };
type ChartRow = Omit<Chart, 'param_values' | 'stacked'> & { param_values: string; stacked: number };
type ScheduleRow = Omit<Schedule, 'param_values'> & { param_values: string };

const toReport = (row: ReportRow): Report => ({ ...row, params: parseParamDefs(row.params) });
const toChart = <T extends ChartRow>(row: T): Omit<T, 'stacked' | 'param_values'> & { stacked: boolean; param_values: ParamValues } => ({
  ...row,
  stacked: row.stacked === 1,
  param_values: parseParamValues(row.param_values),
});

function getReport(db: Database.Database, id: number): Report {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  if (!report) throw new DomainError(404, 'Report not found');
  return toReport(report);
}

function getChart(db: Database.Database, id: number): Chart {
  const chart = db.prepare('SELECT * FROM charts WHERE id = ?').get(id) as ChartRow | undefined;
  if (!chart) throw new DomainError(404, 'Chart not found');
  return toChart(chart);
}

interface ReportInput {
  name: string;
  description: string | null;
  sql: string;
  params: ReportParam[];
}

function validateReport(input: Record<string, unknown>, policy: PolicyOptions): ReportInput {
  const errors: FieldError[] = [];
  const name = reqText(input.name, 'name', errors, 160);
  const description = optText(input.description, 'description', errors, 500);
  const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
  if (sql === '') {
    errors.push({ field: 'sql', message: 'sql is required' });
  } else {
    const check = checkReportSql(sql, policy);
    if (!check.ok) errors.push({ field: 'sql', message: check.reason ?? 'Query rejected by policy' });
  }
  if (errors.length > 0) fail(errors);
  return { name, description, sql, params: validateParamDefs(input.params, sql) };
}

/** The chart options shared by a saved chart and a preview. */
function validateChartConfig(input: Record<string, unknown>, errors: FieldError[]): ChartConfig {
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!(CHART_KINDS as readonly string[]).includes(kind)) {
    errors.push({ field: 'kind', message: `kind must be one of: ${CHART_KINDS.join(', ')}` });
  }
  const x = reqText(input.x_column, 'x_column', errors, 120);
  const y = reqText(input.y_column, 'y_column', errors, 120);
  const series = optText(input.series_column, 'series_column', errors, 120);
  if (series !== null && kind === 'pie') errors.push({ field: 'series_column', message: 'a pie chart has no series — its slices are the x column' });
  return { kind: kind as ChartConfig['kind'], x, y, series, stacked: input.stacked === true };
}

function validateChart(input: Record<string, unknown>): {
  reportId: number;
  name: string;
  config: ChartConfig;
} {
  const errors: FieldError[] = [];
  const reportId = Number(input.report_id);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    errors.push({ field: 'report_id', message: 'report_id must be a positive integer id' });
  }
  const name = reqText(input.name, 'name', errors, 160);
  const config = validateChartConfig(input, errors);
  if (errors.length > 0) fail(errors);
  return { reportId, name, config };
}

/** `?p_from=2026-01-01&p_region=Wien` — parameter values on a download link. */
function queryParams(query: Record<string, unknown>): ParamValues {
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(query)) if (key.startsWith('p_') && typeof value === 'string') out[key.slice(2)] = value;
  return out;
}

const chartConfigOf = (chart: Chart): ChartConfig => ({ kind: chart.kind, x: chart.x_column, y: chart.y_column, series: chart.series_column, stacked: chart.stacked });

function validatePivotConfig(input: Record<string, unknown>): PivotConfig {
  const errors: FieldError[] = [];
  const row = reqText(input.row, 'row', errors, 120);
  const col = optText(input.col, 'col', errors, 120);
  const aggregation = typeof input.aggregation === 'string' ? input.aggregation : '';
  if (!(AGGREGATIONS as readonly string[]).includes(aggregation)) {
    errors.push({ field: 'aggregation', message: `aggregation must be one of: ${AGGREGATIONS.join(', ')}` });
  }
  const measureRaw = input.measure;
  const measure =
    aggregation === 'count' && (measureRaw === undefined || measureRaw === null || measureRaw === '')
      ? '*'
      : typeof measureRaw === 'string' && measureRaw.trim() !== ''
        ? measureRaw.trim()
        : '';
  if (measure === '') errors.push({ field: 'measure', message: 'measure is required' });
  if (errors.length > 0) fail(errors);
  return { row, col, measure, aggregation: aggregation as PivotConfig['aggregation'] };
}

function scheduleRow(db: Database.Database, schedule: ScheduleRow): Record<string, unknown> {
  const report = db.prepare('SELECT name FROM reports WHERE id = ?').get(schedule.report_id) as
    | { name: string }
    | undefined;
  return {
    ...schedule,
    param_values: parseParamValues(schedule.param_values),
    report_name: report?.name ?? '(deleted report)',
    next_due_at: nextDueAt(schedule),
  };
}

// ── App factory ────────────────────────────────────────────────────────

export interface AppOptions {
  /** Optional transport hardening; omit it (as the tests do) to run unthrottled. */
  hardening?: HardeningConfig;
  db: Database.Database;
  sourceDb: Database.Database;
  /**
   * Restrict every query to the source's published `report_*` views — the
   * reporting contract. Defaults to false, which is the module's headline
   * feature: pointed at any SQLite file, the whole schema is fair game.
   */
  sourceViewsOnly?: boolean;
  auth: AuthConfig;
  exportsDir: string;
  /** Absolute path to the built client (dist/client). Omit to serve API only. */
  staticDir?: string;
  /** Optional PS-07 Audit integration; defaults to a no-op (standalone). */
  platform?: PlatformHooks;
  verifyLogin?: LoginVerifier;
  /**
   * The platform machine token (PLATFORM_SERVICE_TOKEN). When set, it is the
   * only credential that opens the shell summary and the handoff routes — the
   * caller is another service in the same stack, not a human. Unset means all
   * of them are closed, which is the standalone default.
   */
  serviceToken?: string;
  /**
   * The shell origins allowed to embed this module and to sign users into it
   * (SHELL_ORIGIN). Empty — the default — leaves the handoff routes unmounted
   * entirely and keeps `X-Frame-Options: DENY` in `hardening.ts`. A list, so a
   * stack can run both MOD-15 Workspace and MOD-16 Mosaic.
   */
  shellOrigins?: string[];
  /**
   * Which credentials the login form should name, served as-is from
   * GET /api/auth-mode. Defaults to this module's own — the standalone case.
   */
  loginMode?: LoginMode;
  /** The clock relative parameter dates are resolved against (tests inject one). */
  now?: () => number;
}

export function createApp({ db, hardening, sourceDb, sourceViewsOnly = false, auth, exportsDir, staticDir, platform = noopPlatform, verifyLogin = nullVerifier, loginMode = LOCAL_LOGIN, serviceToken, shellOrigins = [], now = Date.now }: AppOptions): express.Express {
  const app = express();
  const handoff = shellOrigins.length > 0 ? createHandoff(auth) : null;
  // The policy for THIS request, with the published view set read fresh from
  // the source's catalog (see source-db.ts `sourcePolicy` for why per-check
  // rather than snapshotted at boot). Called at every validation and every
  // execution, so a query can never be checked under looser rules than it
  // runs under — and a view the source publishes later needs no restart here.
  const policy = (): PolicyOptions => sourcePolicy(sourceDb, sourceViewsOnly);

  // Transport hardening: security headers, a default-deny CORS policy and
  // per-IP rate limits. Mounted only when a config is passed — index.ts always
  // passes one, tests do not, so suites stay unthrottled and deterministic.
  if (hardening) {
    // Behind the stack's reverse proxy every socket peer is the proxy, so the
    // forwarded chain is what per-IP limiting and audit logging must read.
    if (hardening.trustProxy > 0) app.set('trust proxy', hardening.trustProxy);
    app.use(hardeningMiddleware(hardening));
  }
  app.use(express.json({ limit: '1mb' }));
  const runCtx: RunContext = { db, sourceDb, exportsDir, sourceViewsOnly, now };

  /** A report's result for the given parameter values — the one path every read takes. */
  const resultOf = (report: Report, values: unknown, field = 'params') =>
    runReportQuery(sourceDb, report.sql, policy(), resolveParams(report.params, values, now(), readSettings(db).timezone, field));

  const withParams = <T extends { params: string | null }>(run: T) => ({ ...run, params: run.params ? (JSON.parse(run.params) as Record<string, unknown>) : null });
  const runOf = (id: number) => withParams(db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as { params: string | null });
  const exportFormat = (raw: unknown): ExportFormat => {
    if (raw === undefined || raw === null || raw === '') return 'csv';
    if (typeof raw !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(raw)) fail([{ field: 'format', message: `format must be one of: ${EXPORT_FORMATS.join(', ')}` }]);
    return raw as ExportFormat;
  };

  /** Query failures are the author's to see (422); anything else is ours (500). */
  const queryFailure = (res: Response, err: unknown): void => {
    if (err instanceof DomainError) throw err;
    const status = (err as { status?: number }).status ?? 500;
    if (status === 422) {
      res.status(422).json({ error: (err as Error).message });
      return;
    }
    throw err;
  };

  // ── Public routes ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness for a deployment healthcheck: the database is reachable and the
  // schema is in place. Liveness (the process answers at all) is /api/health.
  app.get('/api/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  // Which credentials this deployment accepts, read by the login form before
  // anyone is signed in — hence public. With SSO configured, PS-01 validates
  // logins and this module's own admin credentials are rejected, so a form
  // advertising them would send people at a password that cannot work. The org
  // slug is deployment configuration, not a secret.
  app.get('/api/auth-mode', (_req, res) => {
    res.json(loginMode);
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = body(req);
    // SSO seam: when IDENTITY_URL is set, PS-01 validates the credentials;
    // otherwise the local admin credentials do. Either way the module mints
    // its own session below, so the rest of the request path is unchanged.
    const viaSso = await verifyLogin(username, password);
    // An unreachable PS-01 is not a wrong password. Saying 401 here would tell
    // the user to check credentials that were never checked, and would let a
    // broken identity deployment look like a wave of bad logins; 503 says what
    // actually happened, to the user and to whatever is monitoring this.
    if (viaSso !== null && !viaSso.ok && viaSso.reason === 'unavailable') {
      res.status(503).json({ error: 'Identity service unavailable' });
      return;
    }
    // Who signed in: the PS-01 identity when SSO validated it, the local admin
    // otherwise. It rides in the session token and ends up on every audit
    // entry and history row the session writes.
    const actor =
      viaSso === null
        ? checkCredentials(auth, username, password)
          ? auth.username
          : null
        : viaSso.ok
          ? viaSso.actor
          : null;
    if (actor === null) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    // The level rides in the token next to the actor: the local admin manages,
    // a PS-01 identity gets what its module permissions grant.
    const access = viaSso !== null && viaSso.ok ? viaSso.access : 'manage';
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth, actor, Date.now(), access)));
    res.json({ ok: true, username: actor, access });
  });

  // ── Public chart embed: HMAC-signed per chart id, NO session ─────────
  // An invalid, missing or cross-chart token is a 404 (not a 401): an
  // embed URL either resolves to exactly its chart or it does not exist.
  app.get('/embed/chart/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !verifyEmbedToken(auth.secret, id, req.query.token)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const chartRow = db.prepare('SELECT * FROM charts WHERE id = ?').get(id) as ChartRow | undefined;
    if (!chartRow) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const chart = toChart(chartRow);
    const reportRow = db.prepare('SELECT * FROM reports WHERE id = ?').get(chart.report_id) as
      | ReportRow
      | undefined;
    if (!reportRow) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const report = toReport(reportRow);
    try {
      // The chart's own saved values — the query string of an embed URL
      // changes nothing; the token vouches for one chart as it was saved.
      const result = resultOf(report, currentValues(report, chart.param_values));
      const svg = renderChartSvg(result, chartConfigOf(chart));
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      res
        .status(status === 422 ? 422 : 500)
        .type('image/svg+xml')
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="120"><rect width="720" height="120" fill="#0a0a0a"/><text x="16" y="64" fill="#d98a7a" font-family="monospace" font-size="12">chart error: ${String([(err as Error).message, ...((err as { details?: FieldError[] }).details ?? []).map((d) => d.message)].join(': ')).replace(/[<>&]/g, '')}</text></svg>`,
        );
    }
  });

  // ── Everything below /api requires a valid session ───────────────────
  // ── Machine-to-machine ───────────────────────────────────────────────
  // Authenticated with the platform machine token, NOT a staff session: the
  // caller is another service in the same stack. With no token configured
  // every route below is closed, which is the standalone default.
  function requireServiceToken(req: Request): void {
    const provided = req.headers['x-service-token'];
    if (!serviceToken || typeof provided !== 'string' || !safeServiceTokenEqual(provided, serviceToken)) {
      throw new DomainError(401, 'Service token required');
    }
  }

  // What this module looks like on a shell's board (shared/summary.ts).
  app.get('/api/summary', (req, res, next) => {
  // Only ours when a machine token is actually presented.
    //
    // MOD-11 already serves a session-guarded /api/summary of its own, and this
    // route is mounted above the session gate, so without the fallthrough it
    // would shadow that endpoint and answer 401 to the module's own frontend.
    // Rather than give one module a different path from the other fourteen —
    // the contract is worth more than the collision is expensive — this route
    // claims only the requests that are unambiguously the shell's.
    if (req.headers['x-service-token'] === undefined) {
      next();
      return;
    }
        requireServiceToken(req);
    res.json(moduleSummary(db, parseSummaryContext(req.query as Record<string, unknown>)));
  });

  // ── Shell handoff ────────────────────────────────────────────────────
  // Mounted only when the operator named a shell in SHELL_ORIGIN, so a
  // standalone module has no such surface at all. See handoff.ts for why the
  // destination is signed into the ticket rather than passed alongside it.
  if (handoff) {
    app.post('/api/session/handoff', (req, res) => {
      requireServiceToken(req);
      const { actor, path, access } = body(req);
      const level = requestedAccess(access);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      const target = path === undefined ? '/' : path;
      if (!isRedeemPath(target)) throw new DomainError(422, 'path must be module-relative');
      if (level === null) throw new DomainError(422, 'access must be view, edit or manage');
      res.json(handoff.issue(actor.trim(), target, Date.now(), level));
    });

    app.post('/api/session/issue', (req, res) => {
      requireServiceToken(req);
      const { actor, access } = body(req);
      const level = requestedAccess(access);
      if (typeof actor !== 'string' || actor.trim() === '') throw new DomainError(422, 'actor is required');
      if (level === null) throw new DomainError(422, 'access must be view, edit or manage');
      res.json(handoff.issueSession(actor.trim(), Date.now(), level));
    });

    // The browser lands here from an iframe `src`. Deliberately NOT under
    // /api: it is a navigation, and it must stay outside the session gate
    // below — it is how a session is obtained in the first place.
    app.get('/session/handoff', (req, res) => {
      const result = handoff.redeem(req.query.ticket);
      if (!result.ok) {
        // One status for all three verdicts. Which of "never issued",
        // "already used" and "expired" a ticket hit is not something an
        // unauthenticated caller gets to probe for.
        res.status(401).type('text/plain').send('Handoff ticket is not valid');
        return;
      }
      res.setHeader('Set-Cookie', result.cookie);
      res.redirect(302, result.location);
    });
  }

  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: actorOf(res, auth), access: accessOf(res) });
  });

  // ── Source schema + policy (what authors write queries against) ──────
  app.get('/api/source', (_req, res) => {
    res.json({
      tables: describeSource(sourceDb, policy()),
      policy: {
        max_rows: QUERY_POLICY.maxRows,
        timeout_ms: QUERY_POLICY.timeoutMs,
        views_only: sourceViewsOnly,
      },
    });
  });

  // ── Reports CRUD ─────────────────────────────────────────────────────
  app.get('/api/reports', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const reports = db
      .prepare(
        `SELECT * FROM reports
         ${search ? 'WHERE name LIKE @s ESCAPE \'\\\' OR description LIKE @s ESCAPE \'\\\'' : ''}
         ORDER BY name`,
      )
      .all(search ? { s: likeTerm(search) } : {}) as ReportRow[];
    res.json({ reports: reports.map(toReport) });
  });

  app.post('/api/reports', (req, res) => {
    const input = validateReport(body(req), policy());
    const info = db
      .prepare(
        `INSERT INTO reports (name, description, sql, params, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.description, input.sql, JSON.stringify(input.params), nowIso(), nowIso());
    res.status(201).json(getReport(db, Number(info.lastInsertRowid)));
  });

  app.get('/api/reports/:id', (req, res) => {
    res.json(getReport(db, Number(req.params.id)));
  });

  app.put('/api/reports/:id', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const input = validateReport(body(req), policy());
    db.prepare('UPDATE reports SET name = ?, description = ?, sql = ?, params = ?, updated_at = ? WHERE id = ?').run(
      input.name,
      input.description,
      input.sql,
      JSON.stringify(input.params),
      nowIso(),
      report.id,
    );
    res.json(getReport(db, report.id));
  });

  app.delete('/api/reports/:id', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    db.prepare('DELETE FROM reports WHERE id = ?').run(report.id);
    res.json({ ok: true });
  });

  // ── Run a report (live preview) ──────────────────────────────────────
  app.post('/api/reports/:id/run', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    try {
      res.json(resultOf(report, body(req).params));
    } catch (err) {
      queryFailure(res, err);
    }
  });

  // ── Ad-hoc SQL preview (edit-time, not yet saved) ────────────────────
  // The editor sends the parameters it is declaring and the values to try.
  app.post('/api/preview', (req, res) => {
    const sql = typeof body(req).sql === 'string' ? (body(req).sql as string) : '';
    const check = checkReportSql(sql, policy());
    if (!check.ok) {
      res.status(422).json({ error: check.reason });
      return;
    }
    const params = validateParamDefs(body(req).params, sql);
    try {
      res.json(runReportQuery(sourceDb, sql, policy(), resolveParams(params, body(req).values, now(), readSettings(db).timezone, 'values')));
    } catch (err) {
      queryFailure(res, err);
    }
  });

  // ── Download a report's result as CSV ────────────────────────────────
  app.get('/api/reports/:id/export.csv', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    try {
      const result = resultOf(report, queryParams(req.query as Record<string, unknown>));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="report-${report.id}.csv"`,
      );
      res.send(resultToCsv(result));
    } catch (err) {
      queryFailure(res, err);
    }
  });

  // The same result as an Excel workbook; with ?pivot_row=… (and pivot_col,
  // pivot_measure, pivot_aggregation) the pivot comes as a second sheet.
  app.get('/api/reports/:id/export.xlsx', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const q = req.query as Record<string, unknown>;
    const pivotConfig =
      typeof q.pivot_row === 'string' && q.pivot_row !== ''
        ? validatePivotConfig({ row: q.pivot_row, col: q.pivot_col, measure: q.pivot_measure, aggregation: q.pivot_aggregation })
        : null;
    let result;
    try {
      result = resultOf(report, queryParams(q));
    } catch (err) {
      queryFailure(res, err);
      return;
    }
    const sheets = [resultSheet(report.name, result)];
    if (pivotConfig) {
      try {
        sheets.push(pivotSheet('Pivot', pivotConfig, computePivot(result, pivotConfig)));
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
        return;
      }
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="report-${report.id}.xlsx"`);
    res.send(buildXlsx(sheets));
  });

  // ── Pivot a report result ────────────────────────────────────────────
  app.post('/api/reports/:id/pivot', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const config = validatePivotConfig(body(req));
    let result;
    try {
      result = resultOf(report, body(req).params);
    } catch (err) {
      queryFailure(res, err);
      return;
    }
    try {
      res.json(computePivot(result, config));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      res.status(status === 422 ? 422 : 500).json({ error: (err as Error).message });
    }
  });

  // ── Manual "run now" export of a report ──────────────────────────────
  app.post('/api/reports/:id/run-now', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const format = exportFormat(body(req).format);
    const values = validateParamValues(report.params, body(req).params);
    // A required value left out is the caller's 422, not a failed run in the
    // history — the history is for what ran.
    resolveParams(report.params, values, now(), readSettings(db).timezone);
    const runId = executeRun(runCtx, report, 'manual', null, { format, params: values });
    const run = runOf(runId);
    void platform.audit({ actor: actorOf(res, auth), action: 'report.run', resource: `report:${req.params.id}`, metadata: { run_id: runId } });
    res.status(201).json(run);
  });

  // Live SVG preview of an unsaved chart config against a report.
  app.post('/api/reports/:id/chart-preview', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const input = body(req);
    const errors: FieldError[] = [];
    const config = validateChartConfig(input, errors);
    if (errors.length > 0) fail(errors);
    try {
      const result = resultOf(report, input.params);
      const svg = renderChartSvg(result, config);
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.send(svg);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      const status = (err as { status?: number }).status ?? 500;
      res.status(status === 422 ? 422 : 500).json({ error: (err as Error).message });
    }
  });

  // ── Charts ───────────────────────────────────────────────────────────
  app.get('/api/charts', (_req, res) => {
    const charts = db
      .prepare(
        `SELECT c.*, r.name AS report_name
         FROM charts c JOIN reports r ON r.id = c.report_id
         ORDER BY c.created_at DESC, c.id DESC`,
      )
      .all() as (ChartRow & { report_name: string })[];
    res.json({ charts: charts.map(toChart) });
  });

  app.post('/api/charts', (req, res) => {
    const input = validateChart(body(req));
    const report = getReport(db, input.reportId); // 404 if the report doesn't exist
    // Stored as given — a relative date stays relative, so "this month"
    // still means this month next month.
    const values = validateParamValues(report.params, body(req).params);
    const info = db
      .prepare(
        `INSERT INTO charts (report_id, name, kind, x_column, y_column, series_column, stacked, param_values, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.reportId, input.name, input.config.kind, input.config.x, input.config.y, input.config.series ?? null, input.config.stacked ? 1 : 0, JSON.stringify(values), nowIso());
    res.status(201).json(getChart(db, Number(info.lastInsertRowid)));
  });

  app.get('/api/charts/:id', (req, res) => {
    res.json(getChart(db, Number(req.params.id)));
  });

  app.delete('/api/charts/:id', (req, res) => {
    getChart(db, Number(req.params.id));
    db.prepare('DELETE FROM charts WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Authed SVG preview of a saved chart.
  app.get('/api/charts/:id/svg', (req, res) => {
    const chart = getChart(db, Number(req.params.id));
    const report = getReport(db, chart.report_id);
    try {
      const result = resultOf(report, currentValues(report, chart.param_values));
      const svg = renderChartSvg(result, chartConfigOf(chart));
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.send(svg);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      const status = (err as { status?: number }).status ?? 500;
      res.status(status === 422 ? 422 : 500).json({ error: (err as Error).message });
    }
  });

  // The signed embed URL + token for a saved chart.
  app.get('/api/charts/:id/embed', (req, res) => {
    const chart = getChart(db, Number(req.params.id));
    const token = createEmbedToken(auth.secret, chart.id);
    res.json({
      chart_id: chart.id,
      token,
      path: `/embed/chart/${chart.id}?token=${token}`,
    });
  });

  // ── Schedules ────────────────────────────────────────────────────────
  app.get('/api/schedules', (_req, res) => {
    const schedules = db.prepare('SELECT * FROM schedules ORDER BY id').all() as ScheduleRow[];
    res.json({ schedules: schedules.map((s) => scheduleRow(db, s)) });
  });

  // Upsert the (single) schedule for a report.
  app.put('/api/schedules/report/:reportId', (req, res) => {
    const report = getReport(db, Number(req.params.reportId));
    const input = body(req);
    const errors: FieldError[] = [];
    const interval = typeof input.interval === 'string' ? input.interval : '';
    if (!(SCHEDULE_INTERVALS as readonly string[]).includes(interval)) {
      errors.push({ field: 'interval', message: `interval must be one of: ${SCHEDULE_INTERVALS.join(', ')}` });
    }
    const enabled = input.enabled === undefined ? 1 : input.enabled ? 1 : 0;
    if (errors.length > 0) fail(errors);
    const existing = db.prepare('SELECT * FROM schedules WHERE report_id = ?').get(report.id) as
      | ScheduleRow
      | undefined;
    // Left out means "as it is": switching a schedule off must not quietly
    // reset its format or the values it runs with.
    const format = input.format === undefined && existing ? existing.format : exportFormat(input.format);
    const values = input.params === undefined && existing ? existing.param_values : JSON.stringify(validateParamValues(report.params, input.params));

    if (existing) {
      db.prepare('UPDATE schedules SET interval = ?, enabled = ?, format = ?, param_values = ? WHERE id = ?').run(
        interval,
        enabled,
        format,
        values,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO schedules (report_id, interval, format, enabled, param_values, last_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).run(report.id, interval, format, enabled, values, nowIso());
    }
    const saved = db.prepare('SELECT * FROM schedules WHERE report_id = ?').get(report.id) as ScheduleRow;
    res.json(scheduleRow(db, saved));
  });

  app.delete('/api/schedules/:id', (req, res) => {
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(req.params.id)) as
      | Schedule
      | undefined;
    if (!schedule) throw new DomainError(404, 'Schedule not found');
    db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);
    res.json({ ok: true });
  });

  // Manual "run now" of a schedule (stamps last_run_at, like a tick).
  app.post('/api/schedules/:id/run-now', (req, res) => {
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(req.params.id)) as
      | ScheduleRow
      | undefined;
    if (!schedule) throw new DomainError(404, 'Schedule not found');
    const report = getReport(db, schedule.report_id);
    const runId = executeRun(runCtx, report, 'manual', schedule.id, { format: schedule.format, params: parseParamValues(schedule.param_values) });
    db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(nowIso(), schedule.id);
    res.status(201).json(runOf(runId));
  });

  // ── Run history (append-only) ────────────────────────────────────────
  app.get('/api/runs', (req, res) => {
    const reportId = Number(req.query.report_id);
    const hasFilter = Number.isInteger(reportId) && reportId > 0;
    const runs = db
      .prepare(
        `SELECT run.*, r.name AS report_name
         FROM runs run JOIN reports r ON r.id = run.report_id
         ${hasFilter ? 'WHERE run.report_id = @id' : ''}
         ORDER BY run.id DESC
         LIMIT 200`,
      )
      .all(hasFilter ? { id: reportId } : {}) as { params: string | null }[];
    res.json({ runs: runs.map(withParams) });
  });

  // ── Settings (writing is `manage`) ───────────────────────────────────
  app.get('/api/settings', (_req, res) => {
    res.json(readSettings(db));
  });

  app.put('/api/settings', (req, res) => {
    res.json(writeSettings(db, body(req), actorOf(res, auth)));
  });

  // ── Static client (production build) ─────────────────────────────────
  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/embed')) {
        res.sendFile('index.html', { root: staticDir });
        return;
      }
      next();
    });
  }

  // ── Error mapping ────────────────────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
