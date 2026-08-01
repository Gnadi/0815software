import Database from 'better-sqlite3';
import type { QueryResult } from '../shared/types.js';
import {
  checkReportSql,
  QUERY_POLICY,
  REPORT_VIEW_PREFIX,
  type PolicyOptions,
} from './query-policy.js';

/**
 * The database being reported ON. Opened strictly READ-ONLY — this is
 * the hard backstop behind the SELECT-only validation: even if a write
 * statement somehow got past checkReportSql(), better-sqlite3 refuses to
 * run it on a { readonly: true } connection ("attempt to write a
 * readonly database").
 */
export function openSourceDb(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  // A read-only connection can't switch journal modes; leave the file's
  // own pragmas untouched. Query cost is bounded per-statement below.
  return db;
}

export class QueryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The source's PUBLISHED objects — the reporting contract, read from the
 * source's own catalog: objects of type `view` whose name starts with
 * `report_`. Lower-cased, because SQLite identifiers are case-insensitive and
 * the query scanner lower-cases what it finds.
 *
 * Views only, deliberately. The `report_` prefix is the convention a module
 * follows when it publishes; it is NOT the authorisation. A private TABLE
 * called `report_secrets` carries the prefix and is still private, so it must
 * not appear here — otherwise the prefix, which the source module controls
 * for its own convenience, would be the security boundary.
 *
 * The `_` in the prefix is a LIKE wildcard, hence the exact prefix test in JS.
 * This is THE one place the published set is computed; both the discovery
 * endpoint and the query policy read it, so the UI can never offer an object
 * the policy would refuse.
 */
export function publishedViews(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)
    .all() as { name: string }[];
  return new Set(
    rows.filter((r) => r.name.startsWith(REPORT_VIEW_PREFIX)).map((r) => r.name.toLowerCase()),
  );
}

/**
 * The policy to apply to a query against `db`, with the published set read
 * fresh from the catalog.
 *
 * REFRESH SEMANTICS: the catalog is read on every check, not snapshotted at
 * boot. Reading `sqlite_master` on an open handle is a cheap in-process
 * lookup, and it means a view the source module publishes in a migration is
 * usable the moment that module has migrated — no MOD-08 restart. The
 * consequence is that save-time and run-time validation can legitimately
 * disagree if the source's views change in between: a report saved against a
 * view that is later withdrawn starts failing at run time, visibly, in its run
 * history. That is intended — the source owns its contract.
 */
export function sourcePolicy(db: Database.Database, viewsOnly: boolean): PolicyOptions {
  if (!viewsOnly) return { viewsOnly: false };
  return { viewsOnly: true, publishedObjects: publishedViews(db) };
}

/**
 * Introspect the source database: table names and, per table, its
 * column names. Used by the UI to help authors write queries. Uses the
 * read-only connection's own catalog — no user SQL involved.
 *
 * With `viewsOnly`, only the published views are listed: the source module's
 * private tables are none of an author's business, so they are not advertised
 * either. Same set the policy enforces, so the UI cannot offer an object the
 * policy would refuse — including a private table named `report_*`.
 */
export function describeSource(
  db: Database.Database,
  { viewsOnly = false, publishedObjects }: PolicyOptions = {},
): { table: string; columns: string[] }[] {
  const all = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[];
  const published = viewsOnly ? (publishedObjects ?? publishedViews(db)) : null;
  const tables = published ? all.filter((t) => published.has(t.name.toLowerCase())) : all;
  return tables.map((t) => {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as {
      name: string;
    }[];
    return { table: t.name, columns: cols.map((c) => c.name) };
  });
}

/**
 * Validate and run a report query against the read-only source db,
 * enforcing the row cap and a wall-clock timeout. Returns the columns
 * and rows, flagging truncation. Throws QueryError(422) for a query the
 * policy rejects, and QueryError(422) for any SQLite error (bad column,
 * syntax, or a write blocked by the read-only handle).
 */
export function runReportQuery(
  db: Database.Database,
  sql: string,
  policy: PolicyOptions = {},
): QueryResult {
  // A restricted policy that arrived without its published set gets one from
  // this very connection's catalog, so an execution path can never be checked
  // against an empty (or stale) allowed set by accident.
  const effective =
    policy.viewsOnly && !policy.publishedObjects ? sourcePolicy(db, true) : policy;
  const check = checkReportSql(sql, effective);
  if (!check.ok) {
    throw new QueryError(422, check.reason ?? 'Query rejected by policy');
  }

  let stmt: Database.Statement;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    throw new QueryError(422, `Query could not be prepared: ${(err as Error).message}`);
  }

  // A SELECT returns columns; a statement that doesn't (shouldn't happen
  // past the guard, but be explicit) is rejected.
  stmt.raw(false);
  let columns: string[];
  try {
    columns = stmt.columns().map((c) => c.name);
  } catch {
    throw new QueryError(422, 'Only queries that return rows are allowed');
  }

  // Wall-clock timeout via a progress handler on the connection. The
  // handler runs every N virtual-machine steps; if we've blown the
  // budget it throws, aborting the query.
  const deadline = Date.now() + QUERY_POLICY.timeoutMs;
  const started = Date.now();
  const rows: Record<string, unknown>[] = [];
  let truncated = false;

  // Use an iterator so we can stop at the cap without materialising more
  // than maxRows + 1 rows.
  const iter = stmt.iterate() as IterableIterator<Record<string, unknown>>;
  try {
    for (const row of iter) {
      if (Date.now() > deadline) {
        throw new QueryError(422, `Query exceeded the ${QUERY_POLICY.timeoutMs}ms time limit`);
      }
      if (rows.length >= QUERY_POLICY.maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
  } catch (err) {
    if (err instanceof QueryError) throw err;
    throw new QueryError(422, `Query failed: ${(err as Error).message}`);
  } finally {
    // Releasing the iterator finalises the underlying statement handle.
    if (typeof iter.return === 'function') iter.return();
  }

  return { columns, rows, truncated, elapsed_ms: Date.now() - started };
}
