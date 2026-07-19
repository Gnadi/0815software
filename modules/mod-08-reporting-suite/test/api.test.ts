import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { openSourceDb } from '../server/source-db.js';
import { seedSourceDb, seedMeta } from '../server/seed.js';
import { computePivot } from '../server/pivot.js';
import { renderChartSvg } from '../server/charts.js';
import { checkReportSql } from '../server/query-policy.js';
import { createEmbedToken } from '../server/auth.js';
import { tick } from '../server/scheduler.js';
import type { AuthConfig } from '../server/auth.js';
import type { QueryResult } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let tmp: string;
let sourcePath: string;
let exportsDir: string;
let db: Database.Database;
let sourceDb: Database.Database;
let app: Express;
let cookie: string;

/** superagent buffers image/svg+xml into res.body (Buffer), not res.text. */
function svgText(res: request.Response): string {
  if (typeof res.text === 'string' && res.text.length > 0) return res.text;
  if (Buffer.isBuffer(res.body)) return res.body.toString('utf8');
  return '';
}

async function login(): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function createReport(name: string, sql: string): Promise<number> {
  const res = await request(app).post('/api/reports').set('Cookie', cookie).send({ name, sql });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mod08-'));
  sourcePath = join(tmp, 'source.db');
  exportsDir = join(tmp, 'exports');

  const writable = new Database(sourcePath);
  seedSourceDb(writable);
  writable.close();

  db = openDb(':memory:');
  seedMeta(db, exportsDir);
  sourceDb = openSourceDb(sourcePath);
  app = createApp({ db, sourceDb, auth, exportsDir });
  cookie = await login();
});

afterAll(() => {
  db.close();
  sourceDb.close();
});

// ── Auth ────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects unauthenticated API requests with 401', async () => {
    for (const path of ['/api/me', '/api/source', '/api/reports', '/api/charts', '/api/schedules', '/api/runs']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/reports').send({ name: 'x', sql: 'SELECT 1' });
    expect(post.status).toBe(401);
  });

  it('accepts good credentials and sets an HttpOnly mod08_session cookie', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod08_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });

  it('rejects bad credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'nope' });
    expect(res.status).toBe(401);
  });
});

// ── SELECT-only enforcement (validator) ──────────────────────────────────

describe('checkReportSql — SELECT only', () => {
  const rejected: [string, string][] = [
    ['INSERT', "INSERT INTO regions (name) VALUES ('x')"],
    ['UPDATE', "UPDATE regions SET name = 'x'"],
    ['DELETE', 'DELETE FROM regions'],
    ['REPLACE', "REPLACE INTO regions (id, name) VALUES (1, 'x')"],
    ['DROP', 'DROP TABLE regions'],
    ['CREATE', 'CREATE TABLE t (id INTEGER)'],
    ['ALTER', 'ALTER TABLE regions ADD COLUMN x TEXT'],
    ['PRAGMA', 'PRAGMA table_info(regions)'],
    ['ATTACH', "ATTACH DATABASE 'other.db' AS other"],
    ['DETACH', 'DETACH DATABASE other'],
    ['VACUUM', 'VACUUM'],
    ['multi-statement', 'SELECT 1; SELECT 2'],
    ['write after SELECT', "SELECT 1; DELETE FROM regions"],
    ['not a select', 'WITH x AS (SELECT 1) DELETE FROM regions'],
    ['empty', '   '],
  ];
  for (const [label, sql] of rejected) {
    it(`rejects ${label}`, () => {
      expect(checkReportSql(sql).ok).toBe(false);
    });
  }

  const accepted: [string, string][] = [
    ['plain select', 'SELECT 1'],
    ['select with trailing semicolon', 'SELECT 1;'],
    ['WITH cte', 'WITH x AS (SELECT 1 AS n) SELECT n FROM x'],
    ['keyword inside a string literal', "SELECT 'DELETE me' AS label"],
    ['column named update via quotes', 'SELECT id AS "update" FROM regions'],
  ];
  for (const [label, sql] of accepted) {
    it(`accepts ${label}`, () => {
      expect(checkReportSql(sql).ok, sql).toBe(true);
    });
  }
});

describe('SELECT-only enforcement over the API', () => {
  it('rejects a write report at create time with 422', async () => {
    for (const sql of ['DELETE FROM regions', 'UPDATE regions SET name=1', 'DROP TABLE orders', 'PRAGMA table_info(orders)', 'SELECT 1; DELETE FROM regions']) {
      const res = await request(app).post('/api/reports').set('Cookie', cookie).send({ name: 'bad', sql });
      expect(res.status, sql).toBe(422);
    }
  });

  it('rejects running a saved-then-tampered write via the run endpoint (422)', async () => {
    // Insert a write statement directly into metadata, bypassing validation,
    // then run it: it must be rejected (validator on run OR the read-only db).
    const info = db
      .prepare("INSERT INTO reports (name, description, sql, created_at, updated_at) VALUES ('sneaky', NULL, ?, '', '')")
      .run("DELETE FROM regions");
    const id = Number(info.lastInsertRowid);
    const res = await request(app).post(`/api/reports/${id}/run`).set('Cookie', cookie);
    expect(res.status).toBe(422);
  });
});

// ── Read-only backstop ───────────────────────────────────────────────────

describe('read-only source connection is the backstop', () => {
  it('refuses a write on the read-only handle even when prepared directly', () => {
    expect(() => sourceDb.prepare("INSERT INTO regions (name) VALUES ('hack')").run()).toThrow(
      /readonly|read-only/i,
    );
    expect(() => sourceDb.prepare('DROP TABLE orders').run()).toThrow();
  });
});

// ── Row cap ──────────────────────────────────────────────────────────────

describe('row cap', () => {
  it('caps a huge result at the policy maximum and flags truncation', async () => {
    const id = await createReport('cartesian', 'SELECT o1.id FROM orders o1, orders o2, orders o3');
    const res = await request(app).post(`/api/reports/${id}/run`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(10_000);
    expect(res.body.truncated).toBe(true);
  });
});

// ── Pivot correctness (hand-computed) ────────────────────────────────────

const PIVOT_FIXTURE: QueryResult = {
  columns: ['category', 'region', 'amount'],
  truncated: false,
  elapsed_ms: 0,
  rows: [
    { category: 'A', region: 'North', amount: 10 },
    { category: 'A', region: 'North', amount: 30 },
    { category: 'A', region: 'South', amount: 5 },
    { category: 'B', region: 'North', amount: 100 },
    { category: 'B', region: 'South', amount: 7 },
    { category: 'B', region: 'South', amount: 3 },
    // C only appears in South → its North cell must be empty (null).
    { category: 'C', region: 'South', amount: 50 },
  ],
};

describe('computePivot', () => {
  it('sum with a column dimension, empty cells, and grand totals', () => {
    const p = computePivot(PIVOT_FIXTURE, { row: 'category', col: 'region', measure: 'amount', aggregation: 'sum' });
    expect(p.columns).toEqual(['North', 'South']);
    const byKey = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    // A: North 10+30=40, South 5, total 45
    expect(byKey.A!.values).toEqual([40, 5]);
    expect(byKey.A!.total).toBe(45);
    // B: North 100, South 7+3=10, total 110
    expect(byKey.B!.values).toEqual([100, 10]);
    expect(byKey.B!.total).toBe(110);
    // C: North empty → null, South 50, total 50
    expect(byKey.C!.values).toEqual([null, 50]);
    expect(byKey.C!.total).toBe(50);
    // Column totals: North 40+100=140, South 5+10+50=65
    expect(p.columnTotals).toEqual([140, 65]);
    // Grand total 205
    expect(p.grandTotal).toBe(205);
  });

  it('count ignores the measure and counts rows', () => {
    const p = computePivot(PIVOT_FIXTURE, { row: 'category', col: 'region', measure: '*', aggregation: 'count' });
    const byKey = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    expect(byKey.A!.values).toEqual([2, 1]); // North 2, South 1
    expect(byKey.C!.values).toEqual([null, 1]); // empty North
    expect(p.grandTotal).toBe(7);
  });

  it('avg is a true average of the underlying rows, not of cells', () => {
    const p = computePivot(PIVOT_FIXTURE, { row: 'category', col: null, measure: 'amount', aggregation: 'avg' });
    const byKey = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    expect(byKey.A!.values).toEqual([(10 + 30 + 5) / 3]); // 15
    expect(byKey.B!.values).toEqual([(100 + 7 + 3) / 3]);
    // Grand avg over all 7 rows = 205 / 7
    expect(p.grandTotal).toBeCloseTo(205 / 7, 10);
    expect(p.flat).toBe(true);
  });

  it('min and max over the underlying rows', () => {
    const min = computePivot(PIVOT_FIXTURE, { row: 'category', col: null, measure: 'amount', aggregation: 'min' });
    const max = computePivot(PIVOT_FIXTURE, { row: 'category', col: null, measure: 'amount', aggregation: 'max' });
    expect(Object.fromEntries(min.rows.map((r) => [r.key, r.total])).B).toBe(3);
    expect(Object.fromEntries(max.rows.map((r) => [r.key, r.total])).B).toBe(100);
  });

  it('rejects an unknown column with 422', () => {
    expect(() => computePivot(PIVOT_FIXTURE, { row: 'nope', col: null, measure: 'amount', aggregation: 'sum' })).toThrow();
  });

  it('matches the source DB for the API pivot (spot-check one cell)', async () => {
    const id = await createReport(
      'cat-region',
      `SELECT p.category AS category, r.name AS region, SUM(ol.quantity * ol.unit_price_cents) AS revenue_cents
       FROM order_lines ol
       JOIN products p ON p.id = ol.product_id
       JOIN orders o ON o.id = ol.order_id
       JOIN regions r ON r.id = o.region_id
       GROUP BY p.category, r.name`,
    );
    const res = await request(app)
      .post(`/api/reports/${id}/pivot`)
      .set('Cookie', cookie)
      .send({ row: 'category', col: 'region', measure: 'revenue_cents', aggregation: 'sum' });
    expect(res.status).toBe(200);

    // Independently compute Hardware × North straight from the source db.
    const expected = sourceDb
      .prepare(
        `SELECT SUM(ol.quantity * ol.unit_price_cents) AS v
         FROM order_lines ol
         JOIN products p ON p.id = ol.product_id
         JOIN orders o ON o.id = ol.order_id
         JOIN regions r ON r.id = o.region_id
         WHERE p.category = 'Hardware' AND r.name = 'North'`,
      )
      .get() as { v: number };

    const colIdx = res.body.columns.indexOf('North');
    const hwRow = res.body.rows.find((r: { key: string }) => r.key === 'Hardware');
    expect(hwRow.values[colIdx]).toBe(expected.v);
  });
});

// ── Charts (SVG) ─────────────────────────────────────────────────────────

const CHART_FIXTURE: QueryResult = {
  columns: ['label', 'value'],
  truncated: false,
  elapsed_ms: 0,
  rows: [
    { label: 'Jan', value: 10 },
    { label: 'Feb', value: 25 },
    { label: 'Mar', value: 15 },
    { label: 'Apr', value: 40 },
  ],
};

describe('renderChartSvg', () => {
  it('renders a bar chart: one <rect> bar per data point', () => {
    const svg = renderChartSvg(CHART_FIXTURE, { kind: 'bar', x: 'label', y: 'value' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    // One background rect + one rect per bar.
    const rects = svg.match(/<rect /g)!.length;
    expect(rects).toBe(1 + CHART_FIXTURE.rows.length);
  });

  it('renders a line chart: one <polyline> and one <circle> per point', () => {
    const svg = renderChartSvg(CHART_FIXTURE, { kind: 'line', x: 'label', y: 'value' });
    expect((svg.match(/<polyline /g) ?? []).length).toBe(1);
    expect((svg.match(/<circle /g) ?? []).length).toBe(CHART_FIXTURE.rows.length);
  });

  it('rejects a y column that is not in the result (422)', () => {
    expect(() => renderChartSvg(CHART_FIXTURE, { kind: 'bar', x: 'label', y: 'nope' })).toThrow();
  });

  it('serves a saved chart SVG over the API', async () => {
    const reportId = await createReport('chart-report', 'SELECT o.order_date AS day, COUNT(*) AS n FROM orders o GROUP BY day ORDER BY day');
    const chart = await request(app).post('/api/charts').set('Cookie', cookie).send({
      report_id: reportId,
      name: 'c',
      kind: 'line',
      x_column: 'day',
      y_column: 'n',
    });
    expect(chart.status).toBe(201);
    const svg = await request(app).get(`/api/charts/${chart.body.id}/svg`).set('Cookie', cookie);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svgText(svg).startsWith('<svg')).toBe(true);
  });
});

// ── Chart embeds ─────────────────────────────────────────────────────────

describe('chart embeds', () => {
  let chartA = 0;
  let chartB = 0;

  beforeAll(async () => {
    const reportId = await createReport('embed-report', 'SELECT o.order_date AS day, COUNT(*) AS n FROM orders o GROUP BY day');
    for (const kind of ['bar', 'line']) {
      const res = await request(app).post('/api/charts').set('Cookie', cookie).send({
        report_id: reportId,
        name: `embed-${kind}`,
        kind,
        x_column: 'day',
        y_column: 'n',
      });
      if (kind === 'bar') chartA = res.body.id;
      else chartB = res.body.id;
    }
  });

  it('renders with a valid token and NO session', async () => {
    const token = createEmbedToken(auth.secret, chartA);
    const res = await request(app).get(`/embed/chart/${chartA}?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(svgText(res).startsWith('<svg')).toBe(true);
  });

  it('404s with no token', async () => {
    const res = await request(app).get(`/embed/chart/${chartA}`);
    expect(res.status).toBe(404);
  });

  it('404s with a tampered token', async () => {
    const token = createEmbedToken(auth.secret, chartA) + 'ff';
    const res = await request(app).get(`/embed/chart/${chartA}?token=${token}`);
    expect(res.status).toBe(404);
  });

  it("404s when chart B's token is used on chart A", async () => {
    const tokenB = createEmbedToken(auth.secret, chartB);
    const res = await request(app).get(`/embed/chart/${chartA}?token=${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('the embed endpoint returns the signed path', async () => {
    const res = await request(app).get(`/api/charts/${chartA}/embed`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(`/embed/chart/${chartA}?token=${createEmbedToken(auth.secret, chartA)}`);
  });
});

// ── Schedules, run history, CSV ──────────────────────────────────────────

describe('scheduled + manual export runs', () => {
  it('a manual run appends one history row and writes a CSV with a matching row count', async () => {
    const id = await createReport('regions-list', 'SELECT id, name FROM regions ORDER BY id');
    const expectedRows = (sourceDb.prepare('SELECT COUNT(*) AS n FROM regions').get() as { n: number }).n;

    const res = await request(app).post(`/api/reports/${id}/run-now`).set('Cookie', cookie);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.row_count).toBe(expectedRows);

    // History row is visible.
    const runs = await request(app).get(`/api/runs?report_id=${id}`).set('Cookie', cookie);
    expect(runs.body.runs.length).toBe(1);

    // CSV file exists and its data-row count matches.
    const file = res.body.file_path as string;
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').split('\r\n').filter((l) => l.length > 0);
    expect(lines.length - 1).toBe(expectedRows); // minus the header row
  });

  it('the scheduler tick runs a due schedule and stamps last_run_at', async () => {
    const id = await createReport('sched-report', 'SELECT id FROM regions');
    const up = await request(app)
      .put(`/api/schedules/report/${id}`)
      .set('Cookie', cookie)
      .send({ interval: 'hourly', enabled: true });
    expect(up.status).toBe(200);
    const scheduleId = up.body.id as number;

    // Never run → due now. One tick should create exactly one run for it.
    const before = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE schedule_id = ?').get(scheduleId) as { n: number }).n;
    const created = tick({ db, sourceDb, exportsDir });
    expect(created.length).toBeGreaterThanOrEqual(1);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE schedule_id = ?').get(scheduleId) as { n: number }).n;
    expect(after).toBe(before + 1);

    const sched = db.prepare('SELECT last_run_at FROM schedules WHERE id = ?').get(scheduleId) as { last_run_at: string };
    expect(sched.last_run_at).not.toBeNull();

    // A second immediate tick must NOT run it again (not due until +1h).
    const again = tick({ db, sourceDb, exportsDir });
    expect(again).not.toContain(scheduleId);
  });

  it('manual run-now on a schedule appends history', async () => {
    const id = await createReport('sched-manual', 'SELECT name FROM regions');
    const up = await request(app).put(`/api/schedules/report/${id}`).set('Cookie', cookie).send({ interval: 'daily' });
    const scheduleId = up.body.id as number;
    const res = await request(app).post(`/api/schedules/${scheduleId}/run-now`).set('Cookie', cookie);
    expect(res.status).toBe(201);
    expect(res.body.trigger).toBe('manual');
    expect(res.body.status).toBe('ok');
  });
});
