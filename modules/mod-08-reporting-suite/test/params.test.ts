import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { openSourceDb } from '../server/source-db.js';
import { seedMeta, seedSourceDb } from '../server/seed.js';
import { resolveParams, resolveRelativeDate, validateParamDefs, validateParamValues } from '../server/params.js';
import { queryParameters } from '../server/query-policy.js';
import { tick } from '../server/scheduler.js';
import { createEmbedToken, type AuthConfig } from '../server/auth.js';
import type { ReportParam } from '../shared/types.js';
import { unzip } from './unzip.js';

/**
 * Report parameters: `:name` placeholders the report declares, values bound
 * by SQLite (never pasted into the SQL), relative dates resolved where the
 * office is. The clock is injected — "today" is 31 October 2026 in Vienna,
 * which is still 30 October in UTC: the case a UTC shortcut gets wrong.
 */

const NOW = Date.parse('2026-10-30T23:30:00Z'); // 00:30 on 31 October in Vienna (CET, after the switch back)
const TZ = 'Europe/Vienna';

describe('relative dates', () => {
  it.each([
    ['today', '2026-10-31'],
    ['yesterday', '2026-10-30'],
    ['today-7', '2026-10-24'],
    ['today+1', '2026-11-01'],
    ['week_start', '2026-10-26'], // the Monday of the week of Saturday 31 October
    ['month_start', '2026-10-01'],
    ['month_end', '2026-10-31'],
    ['prev_month_start', '2026-09-01'],
    ['prev_month_end', '2026-09-30'],
    ['year_start', '2026-01-01'],
    ['prev_year_start', '2025-01-01'],
    ['prev_year_end', '2025-12-31'],
  ])('%s → %s in Vienna', (token, date) => {
    expect(resolveRelativeDate(token, NOW, TZ)).toBe(date);
  });

  it('is a day where the office is: the same instant is still the 30th in UTC and New York', () => {
    expect(resolveRelativeDate('today', NOW, 'UTC')).toBe('2026-10-30');
    expect(resolveRelativeDate('today', NOW, 'America/New_York')).toBe('2026-10-30');
    expect(resolveRelativeDate('month_end', NOW, 'UTC')).toBe('2026-10-31');
  });

  it('crosses years and leap days correctly', () => {
    const jan = Date.parse('2026-01-15T12:00:00Z');
    expect(resolveRelativeDate('prev_month_start', jan, TZ)).toBe('2025-12-01');
    expect(resolveRelativeDate('prev_month_end', jan, TZ)).toBe('2025-12-31');
    expect(resolveRelativeDate('today-15', jan, TZ)).toBe('2025-12-31');
    const leap = Date.parse('2028-03-10T12:00:00Z');
    expect(resolveRelativeDate('prev_month_end', leap, TZ)).toBe('2028-02-29');
    expect(resolveRelativeDate('prev_month_end', Date.parse('2027-03-10T12:00:00Z'), TZ)).toBe('2027-02-28');
  });
});

describe('declarations and the SQL agree', () => {
  const date = (name: string, extra: Partial<ReportParam> = {}) => ({ name, type: 'date', ...extra });

  it('reads :name from the code only — not from string literals or comments', () => {
    expect(queryParameters("SELECT ':nope', x FROM t -- :neither\nWHERE a = :yes /* :no */ AND b = :yes")).toEqual({ names: ['yes'], positional: false, otherStyle: [] });
    expect(queryParameters('SELECT * FROM t WHERE a = ?').positional).toBe(true);
    expect(queryParameters('SELECT * FROM t WHERE a = @a OR b = $b').otherStyle).toEqual(['@a', '$b']);
  });

  it('a placeholder nobody declared, and a declaration nobody uses, are refused when saving', () => {
    const fields = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return ((err as { details: { message: string }[] }).details ?? []).map((d) => d.message);
      }
      return [];
    };
    expect(fields(() => validateParamDefs([], 'SELECT * FROM orders WHERE order_date >= :from'))).toEqual(['the SQL uses :from — declare it']);
    expect(fields(() => validateParamDefs([date('from'), date('to')], 'SELECT * FROM orders WHERE order_date >= :from'))).toEqual([':to is declared but the SQL never uses it']);
    expect(fields(() => validateParamDefs([], 'SELECT * FROM orders WHERE id = ?'))).toEqual(['use named parameters (:name), not ? — values are matched by name']);
    expect(fields(() => validateParamDefs([date('from')], 'SELECT * FROM orders WHERE order_date >= @from'))).toContain('write :from, not @from — parameters are named with a colon');
    expect(fields(() => validateParamDefs([date('a'), date('a')], 'SELECT :a'))).toContain(':a is declared twice');
    expect(fields(() => validateParamDefs([{ name: 'r', type: 'choice' }], 'SELECT :r'))).toEqual(['a choice needs at least one option']);
    expect(fields(() => validateParamDefs([{ name: 'n', type: 'money' }], 'SELECT :n'))).toEqual(['must be one of: text, number, date, choice']);
    expect(fields(() => validateParamDefs([date('d', { default: '31.10.2026' })], 'SELECT :d'))[0]).toMatch(/^must be a date/);
    expect(fields(() => validateParamDefs([{ name: '1x', type: 'text' }], 'SELECT 1'))[0]).toMatch(/^must be a name for the SQL/);
  });

  it('keeps a relative default relative and gives a label to a parameter without one', () => {
    expect(validateParamDefs([date('from', { default: 'prev_month_start', required: true })], 'SELECT :from')).toEqual([
      { name: 'from', label: 'from', type: 'date', required: true, default: 'prev_month_start', choices: [] },
    ]);
  });

  it('values: given over default, numbers as numbers, a missing optional one binds NULL, a missing required one names itself', () => {
    const defs = validateParamDefs(
      [
        { name: 'from', label: 'From', type: 'date', required: true, default: 'month_start' },
        { name: 'min', label: 'Minimum', type: 'number' },
        { name: 'region', label: 'Region', type: 'choice', choices: ['North', 'South'] },
      ],
      'SELECT :from, :min, :region',
    );
    expect(resolveParams(defs, { min: '2.5' }, NOW, TZ)).toEqual({ from: '2026-10-01', min: 2.5, region: null });
    expect(resolveParams(defs, { from: '2025-02-01', region: 'South' }, NOW, TZ)).toEqual({ from: '2025-02-01', min: null, region: 'South' });
    expect(() => validateParamValues(defs, { region: 'West' })).toThrow();
    expect(() => validateParamValues(defs, { nope: '1' })).toThrow();
    expect(() => validateParamValues(defs, { min: 'zwölf' })).toThrow();
    const required = validateParamDefs([{ name: 'to', label: 'To', type: 'date', required: true }], 'SELECT :to');
    expect(() => resolveParams(required, {}, NOW, TZ)).toThrow();
    try {
      resolveParams(required, {}, NOW, TZ);
    } catch (err) {
      expect((err as { details: unknown }).details).toEqual([{ field: 'params.to', message: 'To is required' }]);
    }
  });
});

// ── Through the API ──────────────────────────────────────────────────────

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let exportsDir: string;
let db: Database.Database;
let sourceDb: Database.Database;
let app: Express;
let cookie: string;
let periodId: number;

const PERIOD_SQL = `SELECT r.name AS region, COUNT(DISTINCT o.id) AS orders
FROM orders o JOIN regions r ON r.id = o.region_id
WHERE o.order_date BETWEEN :from AND :to
  AND (:region IS NULL OR r.name = :region)
GROUP BY r.id ORDER BY r.name`;

const PERIOD_PARAMS = [
  { name: 'from', label: 'From', type: 'date', required: true, default: '2025-01-01' },
  { name: 'to', label: 'To', type: 'date', required: true, default: '2025-12-31' },
  { name: 'region', label: 'Region', type: 'text' },
];

/** What the source says directly, for comparison. */
function ordersBetween(from: string, to: string, region?: string): { region: string; orders: number }[] {
  return sourceDb
    .prepare(
      `SELECT r.name AS region, COUNT(DISTINCT o.id) AS orders FROM orders o JOIN regions r ON r.id = o.region_id
       WHERE o.order_date BETWEEN ? AND ? ${region ? 'AND r.name = ?' : ''} GROUP BY r.id ORDER BY r.name`,
    )
    .all(...[from, to, ...(region ? [region] : [])]) as { region: string; orders: number }[];
}

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mod08-params-'));
  const sourcePath = join(tmp, 'source.db');
  exportsDir = join(tmp, 'exports');
  const writable = new Database(sourcePath);
  seedSourceDb(writable);
  writable.close();
  db = openDb(':memory:');
  seedMeta(db, exportsDir);
  sourceDb = openSourceDb(sourcePath);
  app = createApp({ db, sourceDb, auth, exportsDir, now: () => NOW });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  const created = await request(app).post('/api/reports').set('Cookie', cookie).send({ name: 'Orders in a period', sql: PERIOD_SQL, params: PERIOD_PARAMS });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  periodId = created.body.id as number;
});

afterAll(() => {
  db.close();
  sourceDb.close();
});

describe('a report with parameters', () => {
  it('saves its declarations and refuses SQL they do not match', async () => {
    const report = await request(app).get(`/api/reports/${periodId}`).set('Cookie', cookie);
    expect(report.body.params.map((p: ReportParam) => `${p.name}:${p.type}:${p.required}:${p.default}`)).toEqual(['from:date:true:2025-01-01', 'to:date:true:2025-12-31', 'region:text:false:null']);
    const bad = await request(app).put(`/api/reports/${periodId}`).set('Cookie', cookie).send({ name: 'x', sql: `${PERIOD_SQL.replace(':region IS NULL OR ', '')} LIMIT :n`, params: PERIOD_PARAMS });
    expect(bad.status).toBe(422);
    expect(bad.body.details).toEqual([{ field: 'params', message: 'the SQL uses :n — declare it' }]);
  });

  it('runs with its defaults, and with given values', async () => {
    const all = await request(app).post(`/api/reports/${periodId}/run`).set('Cookie', cookie).send({});
    expect(all.status).toBe(200);
    expect(all.body.rows).toEqual(ordersBetween('2025-01-01', '2025-12-31'));
    const q1 = await request(app).post(`/api/reports/${periodId}/run`).set('Cookie', cookie).send({ params: { from: '2025-01-01', to: '2025-03-31', region: 'North' } });
    expect(q1.body.rows).toEqual(ordersBetween('2025-01-01', '2025-03-31', 'North'));
    expect(q1.body.rows).toHaveLength(1);
  });

  it('a value is bound, never spliced: SQL in a value is just a region nobody has', async () => {
    const res = await request(app)
      .post(`/api/reports/${periodId}/run`)
      .set('Cookie', cookie)
      .send({ params: { region: "North' OR '1'='1" } });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  it('a bad value is a 422 naming the parameter', async () => {
    const res = await request(app).post(`/api/reports/${periodId}/run`).set('Cookie', cookie).send({ params: { from: 'last tuesday' } });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('params.from');
    const unknown = await request(app).post(`/api/reports/${periodId}/run`).set('Cookie', cookie).send({ params: { since: '2025-01-01' } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.details).toEqual([{ field: 'params.since', message: 'this report has no such parameter' }]);
  });

  it('a required parameter without value or default is refused before anything runs', async () => {
    const created = await request(app)
      .post('/api/reports')
      .set('Cookie', cookie)
      .send({ name: 'Needs a day', sql: 'SELECT COUNT(*) AS n FROM orders WHERE order_date = :day', params: [{ name: 'day', label: 'Day', type: 'date', required: true }] });
    const id = created.body.id as number;
    const run = await request(app).post(`/api/reports/${id}/run`).set('Cookie', cookie).send({});
    expect(run.status).toBe(422);
    expect(run.body.details).toEqual([{ field: 'params.day', message: 'Day is required' }]);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE report_id = ?').get(id) as { n: number }).n;
    const now = await request(app).post(`/api/reports/${id}/run-now`).set('Cookie', cookie).send({});
    expect(now.status).toBe(422);
    expect((db.prepare('SELECT COUNT(*) AS n FROM runs WHERE report_id = ?').get(id) as { n: number }).n).toBe(before);
  });

  it('the editor previews unsaved SQL with the parameters it is declaring', async () => {
    const res = await request(app)
      .post('/api/preview')
      .set('Cookie', cookie)
      .send({ sql: PERIOD_SQL, params: PERIOD_PARAMS, values: { from: '2025-06-01', to: '2025-06-30' } });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual(ordersBetween('2025-06-01', '2025-06-30'));
    const undeclared = await request(app).post('/api/preview').set('Cookie', cookie).send({ sql: PERIOD_SQL });
    expect(undeclared.status).toBe(422);
  });

  it('a download link carries the values as p_<name>, in CSV and in Excel', async () => {
    const csv = await request(app).get(`/api/reports/${periodId}/export.csv?p_from=2025-02-01&p_to=2025-02-28&p_region=South`).set('Cookie', cookie);
    expect(csv.status).toBe(200);
    const [only] = ordersBetween('2025-02-01', '2025-02-28', 'South');
    expect(csv.text.trim().split('\r\n')).toEqual(['region,orders', `South,${only!.orders}`]);

    const xlsx = await request(app)
      .get(`/api/reports/${periodId}/export.xlsx?p_from=2025-02-01&p_to=2025-02-28&pivot_row=region&pivot_measure=orders&pivot_aggregation=sum`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.headers['content-disposition']).toBe(`attachment; filename="report-${periodId}.xlsx"`);
    const parts = unzip(xlsx.body as Buffer);
    expect(parts.get('xl/workbook.xml')!.toString()).toContain('<sheet name="Orders in a period" sheetId="1"');
    expect(parts.get('xl/workbook.xml')!.toString()).toContain('<sheet name="Pivot" sheetId="2"');
    const feb = ordersBetween('2025-02-01', '2025-02-28');
    expect(parts.get('xl/worksheets/sheet1.xml')!.toString()).toContain(`<c r="B2"><v>${feb[0]!.orders}</v></c>`);
    expect(parts.get('xl/worksheets/sheet2.xml')!.toString()).toContain(`<v>${feb.reduce((a, r) => a + r.orders, 0)}</v>`);

    const badPivot = await request(app).get(`/api/reports/${periodId}/export.xlsx?pivot_row=region&pivot_aggregation=median`).set('Cookie', cookie);
    expect(badPivot.status).toBe(422);
  });
});

describe('saved values on schedules and charts', () => {
  it('a schedule keeps "last month" relative, exports Excel, and the run records the dates it bound', async () => {
    const created = await request(app)
      .post('/api/reports')
      .set('Cookie', cookie)
      .send({
        name: 'Last month',
        sql: 'SELECT COUNT(*) AS orders, :from AS from_day, :to AS to_day FROM orders WHERE order_date BETWEEN :from AND :to',
        params: [
          { name: 'from', type: 'date', required: true, default: 'prev_month_start' },
          { name: 'to', type: 'date', required: true },
        ],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    const saved = await request(app).put(`/api/schedules/report/${id}`).set('Cookie', cookie).send({ interval: 'daily', format: 'xlsx', params: { to: 'prev_month_end' } });
    expect(saved.status).toBe(200);
    expect(saved.body.format).toBe('xlsx');
    expect(saved.body.param_values).toEqual({ to: 'prev_month_end' });

    const ran = tick({ db, sourceDb, exportsDir, now: () => NOW });
    const run = db.prepare('SELECT * FROM runs WHERE schedule_id = ? ORDER BY id DESC').get(saved.body.id) as { id: number; status: string; file_path: string; params: string };
    expect(ran).toContain(run.id);
    expect(run.status).toBe('ok');
    expect(run.file_path.endsWith('.xlsx')).toBe(true);
    expect(existsSync(run.file_path)).toBe(true);
    expect(JSON.parse(run.params)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const sheet = unzip(readFileSync(run.file_path)).get('xl/worksheets/sheet1.xml')!.toString();
    // The bound dates come back as real Excel dates: 2026-09-01 is day 46266.
    expect(sheet).toContain('<c r="B2" s="2"><v>46266</v></c>');

    const list = await request(app).get(`/api/runs?report_id=${id}`).set('Cookie', cookie);
    expect(list.body.runs[0].params).toEqual({ from: '2026-09-01', to: '2026-09-30' });

    const refused = await request(app).put(`/api/schedules/report/${id}`).set('Cookie', cookie).send({ interval: 'daily', format: 'pdf' });
    expect(refused.status).toBe(422);
    // Switching it off keeps its format and values.
    const off = await request(app).put(`/api/schedules/report/${id}`).set('Cookie', cookie).send({ interval: 'daily', enabled: false });
    expect(off.body).toMatchObject({ enabled: 0, format: 'xlsx', param_values: { to: 'prev_month_end' } });
  });

  it('a manual run-now can ask for Excel and for values', async () => {
    const res = await request(app).post(`/api/reports/${periodId}/run-now`).set('Cookie', cookie).send({ format: 'xlsx', params: { from: '2025-05-01', to: '2025-05-31' } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.file_path.endsWith('.xlsx')).toBe(true);
    expect(res.body.params).toEqual({ from: '2025-05-01', to: '2025-05-31', region: null });
    expect(res.body.row_count).toBe(ordersBetween('2025-05-01', '2025-05-31').length);
  });

  it('an embedded chart shows its saved values — the URL cannot change them', async () => {
    const chart = await request(app)
      .post('/api/charts')
      .set('Cookie', cookie)
      .send({ report_id: periodId, name: 'North in March', kind: 'bar', x_column: 'region', y_column: 'orders', params: { from: '2025-03-01', to: '2025-03-31', region: 'North' } });
    expect(chart.status, JSON.stringify(chart.body)).toBe(201);
    expect(chart.body.param_values).toEqual({ from: '2025-03-01', to: '2025-03-31', region: 'North' });
    const id = chart.body.id as number;
    const token = createEmbedToken(auth.secret, id);
    const svg = (res: request.Response) => (Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text);
    const embed = await request(app).get(`/embed/chart/${id}?token=${token}&p_region=South&params[region]=South`);
    expect(embed.status).toBe(200);
    const [north] = ordersBetween('2025-03-01', '2025-03-31', 'North');
    expect(svg(embed)).toContain(`<title>North: ${north!.orders}</title>`);
    expect(svg(embed)).not.toContain('South');

    const refused = await request(app).post('/api/charts').set('Cookie', cookie).send({ report_id: periodId, name: 'x', kind: 'bar', x_column: 'region', y_column: 'orders', params: { from: 'soon' } });
    expect(refused.status).toBe(422);
  });

  it('a stored value for a parameter the report has since dropped is ignored, not fatal', async () => {
    const created = await request(app)
      .post('/api/reports')
      .set('Cookie', cookie)
      .send({ name: 'Shrinks', sql: 'SELECT COUNT(*) AS n FROM orders WHERE order_date >= :from', params: [{ name: 'from', type: 'date', default: '2025-01-01' }] });
    const id = created.body.id as number;
    const chart = await request(app).post('/api/charts').set('Cookie', cookie).send({ report_id: id, name: 'n', kind: 'bar', x_column: 'n', y_column: 'n', params: { from: '2025-06-01' } });
    await request(app).put(`/api/reports/${id}`).set('Cookie', cookie).send({ name: 'Shrinks', sql: 'SELECT COUNT(*) AS n FROM orders' });
    const svg = await request(app).get(`/api/charts/${chart.body.id}/svg`).set('Cookie', cookie);
    expect(svg.status).toBe(200);
  });
});

describe('settings: the time zone relative dates are read in', () => {
  it('defaults to Vienna, refuses a zone that does not exist, and moves "today" when changed', async () => {
    const read = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(read.body).toEqual({ timezone: 'Europe/Vienna', updated_by: null, updated_at: null });

    const bad = await request(app).put('/api/settings').set('Cookie', cookie).send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(422);
    expect(bad.body.details[0].field).toBe('timezone');

    const today = { sql: 'SELECT :d AS d', params: [{ name: 'd', type: 'date', default: 'today' }] };
    const vienna = await request(app).post('/api/preview').set('Cookie', cookie).send(today);
    expect(vienna.body.rows).toEqual([{ d: '2026-10-31' }]);

    const put = await request(app).put('/api/settings').set('Cookie', cookie).send({ timezone: 'America/New_York' });
    expect(put.status).toBe(200);
    expect(put.body.timezone).toBe('America/New_York');
    expect(put.body.updated_by).toBe('admin');
    const ny = await request(app).post('/api/preview').set('Cookie', cookie).send(today);
    expect(ny.body.rows).toEqual([{ d: '2026-10-30' }]);
    await request(app).put('/api/settings').set('Cookie', cookie).send({ timezone: 'Europe/Vienna' });
  });
});

describe('the seeded examples', () => {
  it('declare what their SQL uses', () => {
    const rows = db.prepare("SELECT sql, params FROM reports WHERE params <> '[]'").all() as { sql: string; params: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(() => validateParamDefs(JSON.parse(row.params), row.sql)).not.toThrow();
  });
});
