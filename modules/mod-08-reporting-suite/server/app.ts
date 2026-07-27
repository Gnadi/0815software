import express, { type NextFunction, type Request, type Response } from 'express';
import { hardeningMiddleware, type HardeningConfig } from './hardening.js';
import type Database from 'better-sqlite3';
import {
  AGGREGATIONS,
  CHART_KINDS,
  SCHEDULE_INTERVALS,
  type Chart,
  type ChartConfig,
  type FieldError,
  type PivotConfig,
  type Report,
  type Schedule,
} from '../shared/types.js';
import {
  checkCredentials,
  clearedCookie,
  createEmbedToken,
  createToken,
  requireAuth,
  sessionCookie,
  verifyEmbedToken,
  type AuthConfig,
} from './auth.js';
import { renderChartSvg } from './charts.js';
import { resultToCsv } from './csv.js';
import { noopPlatform, type PlatformHooks } from './platform.js';
import { nullVerifier, type LoginVerifier } from './sso.js';
import { DomainError, nowIso } from './errors.js';
import { computePivot } from './pivot.js';
import { checkReportSql, QUERY_POLICY, type PolicyOptions } from './query-policy.js';
import { executeRun, type RunContext } from './runs.js';
import { nextDueAt } from './scheduler.js';
import { describeSource, runReportQuery } from './source-db.js';

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

function getReport(db: Database.Database, id: number): Report {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Report | undefined;
  if (!report) throw new DomainError(404, 'Report not found');
  return report;
}

function getChart(db: Database.Database, id: number): Chart {
  const chart = db.prepare('SELECT * FROM charts WHERE id = ?').get(id) as Chart | undefined;
  if (!chart) throw new DomainError(404, 'Chart not found');
  return chart;
}

interface ReportInput {
  name: string;
  description: string | null;
  sql: string;
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
  return { name, description, sql };
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
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!(CHART_KINDS as readonly string[]).includes(kind)) {
    errors.push({ field: 'kind', message: `kind must be one of: ${CHART_KINDS.join(', ')}` });
  }
  const x = reqText(input.x_column, 'x_column', errors, 120);
  const y = reqText(input.y_column, 'y_column', errors, 120);
  if (errors.length > 0) fail(errors);
  return { reportId, name, config: { kind: kind as ChartConfig['kind'], x, y } };
}

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

function scheduleRow(db: Database.Database, schedule: Schedule): Record<string, unknown> {
  const report = db.prepare('SELECT name FROM reports WHERE id = ?').get(schedule.report_id) as
    | { name: string }
    | undefined;
  return {
    ...schedule,
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
}

export function createApp({ db, hardening, sourceDb, sourceViewsOnly = false, auth, exportsDir, staticDir, platform = noopPlatform, verifyLogin = nullVerifier }: AppOptions): express.Express {
  const app = express();
  // One policy object, passed to every validation and every execution, so a
  // query can never be checked under looser rules than it runs under.
  const policy: PolicyOptions = { viewsOnly: sourceViewsOnly };

  // Transport hardening: security headers, a default-deny CORS policy and
  // per-IP rate limits. Mounted only when a config is passed — index.ts always
  // passes one, tests do not, so suites stay unthrottled and deterministic.
  if (hardening) app.use(hardeningMiddleware(hardening));
  app.use(express.json({ limit: '1mb' }));
  const runCtx: RunContext = { db, sourceDb, exportsDir, sourceViewsOnly };

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

  app.post('/api/login', async (req, res) => {
    const { username, password } = body(req);
    // SSO seam: when IDENTITY_URL is set, PS-01 validates the credentials;
    // otherwise the local admin credentials do. Either way the module mints
    // its own session below, so the rest of the request path is unchanged.
    const viaSso = await verifyLogin(username, password);
    const authed = viaSso === null ? checkCredentials(auth, username, password) : viaSso === 'ok';
    if (!authed) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(auth, createToken(auth)));
    res.json({ ok: true, username: auth.username });
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
    const chart = db.prepare('SELECT * FROM charts WHERE id = ?').get(id) as Chart | undefined;
    if (!chart) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(chart.report_id) as
      | Report
      | undefined;
    if (!report) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    try {
      const result = runReportQuery(sourceDb, report.sql, policy);
      const svg = renderChartSvg(result, {
        kind: chart.kind,
        x: chart.x_column,
        y: chart.y_column,
      });
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      res
        .status(status === 422 ? 422 : 500)
        .type('image/svg+xml')
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="120"><rect width="720" height="120" fill="#0a0a0a"/><text x="16" y="64" fill="#d98a7a" font-family="monospace" font-size="12">chart error: ${String((err as Error).message).replace(/[<>&]/g, '')}</text></svg>`,
        );
    }
  });

  // ── Everything below /api requires a valid session ───────────────────
  app.use('/api', requireAuth(auth));

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ username: auth.username });
  });

  // ── Source schema + policy (what authors write queries against) ──────
  app.get('/api/source', (_req, res) => {
    res.json({
      tables: describeSource(sourceDb, policy),
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
         ${search ? 'WHERE name LIKE @s OR description LIKE @s' : ''}
         ORDER BY name`,
      )
      .all(search ? { s: `%${search}%` } : {});
    res.json({ reports });
  });

  app.post('/api/reports', (req, res) => {
    const input = validateReport(body(req), policy);
    const info = db
      .prepare(
        `INSERT INTO reports (name, description, sql, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.description, input.sql, nowIso(), nowIso());
    res.status(201).json(getReport(db, Number(info.lastInsertRowid)));
  });

  app.get('/api/reports/:id', (req, res) => {
    res.json(getReport(db, Number(req.params.id)));
  });

  app.put('/api/reports/:id', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const input = validateReport(body(req), policy);
    db.prepare('UPDATE reports SET name = ?, description = ?, sql = ?, updated_at = ? WHERE id = ?').run(
      input.name,
      input.description,
      input.sql,
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
      res.json(runReportQuery(sourceDb, report.sql, policy));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 422) {
        res.status(422).json({ error: (err as Error).message });
        return;
      }
      throw err;
    }
  });

  // ── Ad-hoc SQL preview (edit-time, not yet saved) ────────────────────
  app.post('/api/preview', (req, res) => {
    const sql = typeof body(req).sql === 'string' ? (body(req).sql as string) : '';
    const check = checkReportSql(sql, policy);
    if (!check.ok) {
      res.status(422).json({ error: check.reason });
      return;
    }
    try {
      res.json(runReportQuery(sourceDb, sql, policy));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 422) {
        res.status(422).json({ error: (err as Error).message });
        return;
      }
      throw err;
    }
  });

  // ── Download a report's result as CSV ────────────────────────────────
  app.get('/api/reports/:id/export.csv', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    try {
      const result = runReportQuery(sourceDb, report.sql, policy);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="report-${report.id}.csv"`,
      );
      res.send(resultToCsv(result));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 422) {
        res.status(422).json({ error: (err as Error).message });
        return;
      }
      throw err;
    }
  });

  // ── Pivot a report result ────────────────────────────────────────────
  app.post('/api/reports/:id/pivot', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const config = validatePivotConfig(body(req));
    let result;
    try {
      result = runReportQuery(sourceDb, report.sql, policy);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 422) {
        res.status(422).json({ error: (err as Error).message });
        return;
      }
      throw err;
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
    const runId = executeRun(runCtx, report, 'manual', null);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    void platform.audit({ actor: auth.username, action: 'report.run', resource: `report:${req.params.id}`, metadata: { run_id: runId } });
    res.status(201).json(run);
  });

  // Live SVG preview of an unsaved chart config against a report.
  app.post('/api/reports/:id/chart-preview', (req, res) => {
    const report = getReport(db, Number(req.params.id));
    const input = body(req);
    const errors: FieldError[] = [];
    const kind = typeof input.kind === 'string' ? input.kind : '';
    if (!(CHART_KINDS as readonly string[]).includes(kind)) {
      errors.push({ field: 'kind', message: `kind must be one of: ${CHART_KINDS.join(', ')}` });
    }
    const x = reqText(input.x_column, 'x_column', errors, 120);
    const y = reqText(input.y_column, 'y_column', errors, 120);
    if (errors.length > 0) fail(errors);
    try {
      const result = runReportQuery(sourceDb, report.sql, policy);
      const svg = renderChartSvg(result, { kind: kind as ChartConfig['kind'], x, y });
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.send(svg);
    } catch (err) {
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
      .all();
    res.json({ charts });
  });

  app.post('/api/charts', (req, res) => {
    const input = validateChart(body(req));
    getReport(db, input.reportId); // 404 if the report doesn't exist
    const info = db
      .prepare(
        `INSERT INTO charts (report_id, name, kind, x_column, y_column, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.reportId, input.name, input.config.kind, input.config.x, input.config.y, nowIso());
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
      const result = runReportQuery(sourceDb, report.sql, policy);
      const svg = renderChartSvg(result, { kind: chart.kind, x: chart.x_column, y: chart.y_column });
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.send(svg);
    } catch (err) {
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
    const schedules = db.prepare('SELECT * FROM schedules ORDER BY id').all() as Schedule[];
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
      | Schedule
      | undefined;
    if (existing) {
      db.prepare('UPDATE schedules SET interval = ?, enabled = ? WHERE id = ?').run(
        interval,
        enabled,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO schedules (report_id, interval, format, enabled, last_run_at, created_at)
         VALUES (?, ?, 'csv', ?, NULL, ?)`,
      ).run(report.id, interval, enabled, nowIso());
    }
    const saved = db.prepare('SELECT * FROM schedules WHERE report_id = ?').get(report.id) as Schedule;
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
      | Schedule
      | undefined;
    if (!schedule) throw new DomainError(404, 'Schedule not found');
    const report = getReport(db, schedule.report_id);
    const runId = executeRun(runCtx, report, 'manual', schedule.id);
    db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(nowIso(), schedule.id);
    res.status(201).json(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
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
      .all(hasFilter ? { id: reportId } : {});
    res.json({ runs });
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
