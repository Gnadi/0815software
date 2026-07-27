/**
 * SOURCE_VIEWS_ONLY — the optional fourth layer of the query policy.
 *
 * A module that wants to be reported on publishes `report_*` views in its own
 * database; those views are the contract and its tables stay private
 * (docs/REPORTING-CONTRACT.md). With SOURCE_VIEWS_ONLY set, this module is
 * held to that contract.
 *
 * Two properties are load-bearing, and this suite is built around them:
 *
 *  1. OFF BY DEFAULT, and off means nothing changes. Pointing MOD-08 at an
 *     arbitrary customer database and querying whatever is in it is the
 *     feature that makes this module sellable on its own; the same assertions
 *     run in both modes to prove the default is untouched.
 *  2. ON MEANS ON. The restriction is on the tables a query READS, so neither
 *     an alias nor a CTE nor a subquery nor a comma-join gets around it.
 *
 * This layer is a SCOPE restriction, not a safety mechanism — the read-only
 * connection is still what makes a write impossible, and that is asserted here
 * too so the two never get confused.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { cteNames, checkReportSql, scanSourceSurface } from '../server/query-policy.js';
import { describeSource, openSourceDb, runReportQuery, QueryError } from '../server/source-db.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let tmp: string;
let sourceDb: Database.Database;
/** Same source database, two apps: one restricted, one not. */
let strict: Express;
let open: Express;
let strictCookie: string;
let openCookie: string;

/**
 * A source database shaped like a module that publishes a contract: private
 * tables, plus the `report_*` views that are its public surface.
 */
function buildSource(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, secret_note TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER, number TEXT, gross_cents INTEGER);
    INSERT INTO customers (id, name, secret_note) VALUES (1, 'Acme GmbH', 'do not report this');
    INSERT INTO customers (id, name, secret_note) VALUES (2, 'Beta AG', 'nor this');
    INSERT INTO invoices (id, customer_id, number, gross_cents) VALUES (1, 1, 'INV-2026-0001', 12000);
    INSERT INTO invoices (id, customer_id, number, gross_cents) VALUES (2, 2, 'INV-2026-0002', 5000);

    CREATE VIEW report_invoices AS
      SELECT i.number AS invoice_number, c.name AS customer_name, i.gross_cents AS gross_cents
      FROM invoices i JOIN customers c ON c.id = i.customer_id;
    CREATE VIEW report_customers AS
      SELECT id AS customer_id, name AS customer_name FROM customers;
  `);
  db.close();
}

async function login(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mod08-views-'));
  const sourcePath = join(tmp, 'source.db');
  buildSource(sourcePath);
  sourceDb = openSourceDb(sourcePath);

  // Two apps over the SAME source database, differing only in the flag —
  // which is what makes every "…and the other mode still allows it" assertion
  // below a comparison of the flag and nothing else. Metadata is empty (no
  // seedMeta): the example reports target the demo schema, not this fixture.
  strict = createApp({
    db: openDb(':memory:'),
    sourceDb,
    sourceViewsOnly: true,
    auth,
    exportsDir: join(tmp, 'exports-strict'),
  });
  open = createApp({
    db: openDb(':memory:'),
    sourceDb,
    auth,
    exportsDir: join(tmp, 'exports-open'),
  });

  strictCookie = await login(strict);
  openCookie = await login(open);
});

afterAll(() => {
  sourceDb.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── The default: nothing is restricted ───────────────────────────────────

describe('off by default', () => {
  it('checkReportSql called the old way still accepts a private table', () => {
    // The single-argument call is the whole existing call surface; adding the
    // option must not have changed what it means.
    expect(checkReportSql('SELECT * FROM customers').ok).toBe(true);
    expect(checkReportSql('SELECT * FROM customers', {}).ok).toBe(true);
    expect(checkReportSql('SELECT * FROM customers', { viewsOnly: false }).ok).toBe(true);
  });

  it('lists every table and view, and queries any of them', async () => {
    const res = await request(open).get('/api/source').set('Cookie', openCookie);
    expect(res.status).toBe(200);
    expect(res.body.policy.views_only).toBe(false);
    expect(res.body.tables.map((t: { table: string }) => t.table)).toEqual([
      'customers',
      'invoices',
      'report_customers',
      'report_invoices',
    ]);

    const preview = await request(open)
      .post('/api/preview')
      .set('Cookie', openCookie)
      .send({ sql: 'SELECT secret_note FROM customers ORDER BY id' });
    expect(preview.status).toBe(200);
    expect(preview.body.rows[0].secret_note).toBe('do not report this');
  });

  it('saves a report against a private table', async () => {
    const res = await request(open)
      .post('/api/reports')
      .set('Cookie', openCookie)
      .send({ name: 'raw customers', sql: 'SELECT name FROM customers' });
    expect(res.status).toBe(201);
  });
});

// ── On: only the published surface ───────────────────────────────────────

describe('with SOURCE_VIEWS_ONLY on', () => {
  it('advertises only the report_* views', async () => {
    const res = await request(strict).get('/api/source').set('Cookie', strictCookie);
    expect(res.status).toBe(200);
    expect(res.body.policy.views_only).toBe(true);
    expect(res.body.tables.map((t: { table: string }) => t.table)).toEqual([
      'report_customers',
      'report_invoices',
    ]);
    // The columns of a published view are still described in full — the
    // contract is meant to be used.
    expect(res.body.tables[1].columns).toEqual(['invoice_number', 'customer_name', 'gross_cents']);
  });

  it('runs a query against a published view', async () => {
    const res = await request(strict)
      .post('/api/preview')
      .set('Cookie', strictCookie)
      .send({ sql: 'SELECT invoice_number, gross_cents FROM report_invoices ORDER BY invoice_number' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].invoice_number).toBe('INV-2026-0001');
  });

  it('refuses a query against a private table, and says why', async () => {
    const res = await request(strict)
      .post('/api/preview')
      .set('Cookie', strictCookie)
      .send({ sql: 'SELECT secret_note FROM customers' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/report_\* views/);
    expect(res.body.error).toMatch(/SOURCE_VIEWS_ONLY/);
    expect(res.body.error).toContain('"customers"');
  });

  it('refuses to SAVE a report that reads outside the contract', async () => {
    const res = await request(strict)
      .post('/api/reports')
      .set('Cookie', strictCookie)
      .send({ name: 'peek', sql: 'SELECT * FROM invoices' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/report_\* views/);
  });

  it('refuses to RUN a report smuggled straight into the metadata table', async () => {
    // A report saved before the flag was turned on, or written by hand: the
    // check runs at execution time too, not only at save time.
    const metadata = openDb(':memory:');
    const app = createApp({
      db: metadata,
      sourceDb,
      sourceViewsOnly: true,
      auth,
      exportsDir: join(tmp, 'exports-smuggle'),
    });
    const cookie = await login(app);
    const info = metadata
      .prepare(
        "INSERT INTO reports (name, description, sql, created_at, updated_at) VALUES ('legacy', NULL, ?, '', '')",
      )
      .run('SELECT * FROM customers');
    const res = await request(app)
      .post(`/api/reports/${Number(info.lastInsertRowid)}/run`)
      .set('Cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/report_\* views/);
  });
});

// ── The evasions ─────────────────────────────────────────────────────────

describe('the restriction cannot be aliased or CTE’d away', () => {
  const evasions: [string, string][] = [
    ['an alias that looks published', 'SELECT * FROM customers AS report_c'],
    ['an alias without AS', 'SELECT * FROM customers report_customers'],
    ['a CTE named like a view', 'WITH report_x AS (SELECT * FROM customers) SELECT * FROM report_x'],
    [
      'a RECURSIVE CTE named like a view',
      'WITH RECURSIVE report_x AS (SELECT id FROM customers) SELECT * FROM report_x',
    ],
    [
      'a second CTE in the list',
      'WITH a AS (SELECT 1 AS n), report_b AS (SELECT * FROM invoices) SELECT * FROM report_b',
    ],
    ['a subquery in FROM', 'SELECT * FROM (SELECT * FROM customers)'],
    ['a scalar subquery', 'SELECT (SELECT COUNT(*) FROM customers) AS n'],
    ['a comma join', 'SELECT * FROM report_invoices, customers'],
    ['a comma join the other way round', 'SELECT * FROM customers, report_invoices'],
    ['a comma join after a join constraint', 'SELECT * FROM report_invoices JOIN report_customers ON 1 = 1, customers'],
    ['an explicit JOIN', 'SELECT * FROM report_invoices JOIN customers ON 1 = 1'],
    ['a LEFT OUTER JOIN', 'SELECT * FROM report_invoices LEFT OUTER JOIN customers ON 1 = 1'],
    ['a quoted identifier', 'SELECT * FROM "customers"'],
    ['a bracket-quoted identifier', 'SELECT * FROM [customers]'],
    ['a backtick-quoted identifier', 'SELECT * FROM `customers`'],
    ['different casing', 'SELECT * FROM CUSTOMERS'],
    ['a schema qualifier', 'SELECT * FROM main.customers'],
    ['a UNION arm', 'SELECT invoice_number FROM report_invoices UNION SELECT name FROM customers'],
    ['a table-valued function', "SELECT * FROM pragma_table_info('customers')"],
    ['the sqlite catalogue', 'SELECT name FROM sqlite_master'],
    ['a comment between FROM and the table', 'SELECT * FROM /* report_invoices */ customers'],
    ['a nested subquery three deep', 'SELECT * FROM (SELECT * FROM (SELECT * FROM customers))'],
  ];

  for (const [label, sql] of evasions) {
    it(`refuses ${label}`, () => {
      const check = checkReportSql(sql, { viewsOnly: true });
      expect(check.ok, sql).toBe(false);
      expect(check.reason, sql).toMatch(/report_\* views/);
      // …and the very same query is fine when the flag is off.
      expect(checkReportSql(sql, { viewsOnly: false }).ok, sql).toBe(true);
    });
  }

  const allowed: [string, string][] = [
    ['a plain view read', 'SELECT * FROM report_invoices'],
    ['an aliased view read', 'SELECT r.gross_cents FROM report_invoices AS r'],
    ['two views joined', 'SELECT * FROM report_invoices r JOIN report_customers c ON 1 = 1'],
    ['two views comma-joined', 'SELECT * FROM report_invoices, report_customers'],
    [
      'a CTE over a view',
      'WITH totals AS (SELECT SUM(gross_cents) AS s FROM report_invoices) SELECT s FROM totals',
    ],
    [
      'two CTEs, one feeding the other',
      'WITH a AS (SELECT * FROM report_invoices), b AS (SELECT * FROM a) SELECT * FROM b',
    ],
    ['a subquery over a view', 'SELECT * FROM (SELECT gross_cents FROM report_invoices)'],
    ['a quoted view name', 'SELECT * FROM "report_invoices"'],
    ['a schema-qualified view', 'SELECT * FROM main.report_invoices'],
    ['a UNION of two views', 'SELECT customer_name FROM report_invoices UNION SELECT customer_name FROM report_customers'],
    ['a table name in a string literal', "SELECT 'customers' AS label FROM report_invoices"],
    ['no table at all', 'SELECT 1 AS n'],
  ];

  for (const [label, sql] of allowed) {
    it(`allows ${label}`, () => {
      expect(checkReportSql(sql, { viewsOnly: true }), sql).toEqual({ ok: true });
    });
  }

  it('actually executes the allowed shapes against the read-only source', () => {
    for (const [, sql] of allowed) {
      expect(() => runReportQuery(sourceDb, sql, { viewsOnly: true }), sql).not.toThrow();
    }
  });

  it('refuses rather than guesses when a FROM operand is unreadable', () => {
    // Not valid SQL, and the scanner says so instead of shrugging it through
    // to prepare(). Unknown shape → no.
    const check = checkReportSql('SELECT * FROM 42', { viewsOnly: true });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/report_\* views/);
  });
});

// ── The scanner itself ───────────────────────────────────────────────────

describe('scanSourceSurface / cteNames', () => {
  it('reports the tables a statement reads, at every depth', () => {
    expect(scanSourceSurface('SELECT * FROM a JOIN b ON 1=1, c').refs).toEqual(['a', 'b', 'c']);
    expect(scanSourceSurface('SELECT * FROM (SELECT * FROM inner_t) x').refs).toEqual(['inner_t']);
    expect(scanSourceSurface('SELECT * FROM t WHERE x IN (SELECT y FROM u)').refs).toEqual(['t', 'u']);
    expect(scanSourceSurface('SELECT * FROM (SELECT * FROM x) a, y').refs).toEqual(['x', 'y']);
    expect(scanSourceSurface('SELECT 1').refs).toEqual([]);
  });

  it('reads a comma as another table only while the FROM clause is open', () => {
    // The commas below belong to a select list, an ORDER BY, a LIMIT and a
    // function call — none of them names a table, and treating one as a table
    // would refuse a perfectly legal report.
    expect(scanSourceSurface('SELECT a, b, c FROM t').refs).toEqual(['t']);
    expect(scanSourceSurface('SELECT * FROM t ORDER BY a, b').refs).toEqual(['t']);
    expect(scanSourceSurface('SELECT * FROM t GROUP BY a, b HAVING x > 1').refs).toEqual(['t']);
    expect(scanSourceSurface('SELECT * FROM t LIMIT 10, 5').refs).toEqual(['t']);
    expect(scanSourceSurface('SELECT max(a, b) FROM t').refs).toEqual(['t']);
    expect(scanSourceSurface('SELECT * FROM t WINDOW w AS (PARTITION BY a, b)').refs).toEqual(['t']);
  });

  it('accepts the ordinary report shapes rather than refusing them', () => {
    // Over-refusal is a real failure mode for a scanner like this, so the
    // shapes an author actually writes are asserted to parse cleanly.
    for (const sql of [
      'SELECT strftime(\'%Y-%m\', issue_date) AS m, SUM(gross_cents) FROM report_invoices GROUP BY m ORDER BY m',
      'SELECT * FROM report_invoices r LEFT JOIN report_customers c ON c.customer_id = r.customer_id',
      'WITH open AS (SELECT * FROM report_invoices WHERE outstanding_cents > 0) SELECT COUNT(*) FROM open',
      'SELECT CASE WHEN days_overdue > 30 THEN \'late\' ELSE \'ok\' END AS bucket FROM report_invoices',
    ]) {
      expect(scanSourceSurface(sql).unparsed, sql).toBe(false);
    }
  });

  it('is not fooled by an alias, a literal or a comment', () => {
    expect(scanSourceSurface('SELECT * FROM real_t AS fake_t').refs).toEqual(['real_t']);
    expect(scanSourceSurface("SELECT 'FROM secrets' FROM real_t").refs).toEqual(['real_t']);
    expect(scanSourceSurface('SELECT * FROM -- FROM ghost\n real_t').refs).toEqual(['real_t']);
  });

  it('collects the names a WITH clause binds', () => {
    expect(cteNames('WITH a AS (SELECT 1) SELECT * FROM a')).toEqual(new Set(['a']));
    expect(cteNames('WITH RECURSIVE a AS (SELECT 1) SELECT 1')).toEqual(new Set(['a']));
    expect(cteNames('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT 1')).toEqual(new Set(['a', 'b']));
    expect(cteNames('WITH a(x) AS (SELECT 1) SELECT 1')).toEqual(new Set(['a']));
    expect(cteNames('SELECT * FROM t')).toEqual(new Set());
  });
});

// ── The layers below are untouched ───────────────────────────────────────

describe('the older layers still do their job in views-only mode', () => {
  it('still refuses a write, before the surface check ever matters', () => {
    const check = checkReportSql('DELETE FROM report_invoices', { viewsOnly: true });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/DELETE|SELECT or WITH/);
  });

  it('still refuses a second statement', () => {
    expect(
      checkReportSql('SELECT * FROM report_invoices; SELECT * FROM report_customers', {
        viewsOnly: true,
      }).ok,
    ).toBe(false);
  });

  it('still has the read-only connection underneath it', () => {
    expect(() => sourceDb.prepare("INSERT INTO customers (name) VALUES ('x')").run()).toThrow(
      /readonly|read-only/i,
    );
  });

  it('surfaces the refusal as a 422 QueryError, not a 500', () => {
    expect(() => runReportQuery(sourceDb, 'SELECT * FROM customers', { viewsOnly: true })).toThrow(
      QueryError,
    );
    try {
      runReportQuery(sourceDb, 'SELECT * FROM customers', { viewsOnly: true });
    } catch (err) {
      expect((err as QueryError).status).toBe(422);
    }
  });
});

// ── describeSource ───────────────────────────────────────────────────────

describe('describeSource', () => {
  it('lists everything by default and only the views when restricted', () => {
    expect(describeSource(sourceDb).map((t) => t.table)).toEqual([
      'customers',
      'invoices',
      'report_customers',
      'report_invoices',
    ]);
    expect(describeSource(sourceDb, { viewsOnly: true }).map((t) => t.table)).toEqual([
      'report_customers',
      'report_invoices',
    ]);
  });
});
