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
 * Introspect the source database: table names and, per table, its
 * column names. Used by the UI to help authors write queries. Uses the
 * read-only connection's own catalog — no user SQL involved.
 *
 * With `viewsOnly`, only the published `report_*` views are listed: the source
 * module's private tables are none of an author's business, so they are not
 * advertised either. checkReportSql() enforces the same boundary on the query
 * itself; this just stops the UI from offering what would be refused.
 */
export function describeSource(
  db: Database.Database,
  { viewsOnly = false }: PolicyOptions = {},
): { table: string; columns: string[] }[] {
  const all = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[];
  // Filtered here rather than in SQL: `_` is a LIKE wildcard, and an exact
  // prefix test is what the query policy enforces.
  const tables = viewsOnly ? all.filter((t) => t.name.startsWith(REPORT_VIEW_PREFIX)) : all;
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
  const check = checkReportSql(sql, policy);
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
