import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
/**
 * This module has no migration runner: its schema is idempotent
 * `CREATE TABLE IF NOT EXISTS` plus guarded `ALTER TABLE`s, re-executed on
 * every boot. That IS the upgrade path — a new build opens the customer's
 * existing database and brings the schema forward in place.
 *
 * So the test does what an upgrade does: seed real data, close, re-open with
 * the same code, and check that the schema is identical and every row is still
 * there. An unguarded ALTER, a CREATE without IF NOT EXISTS, or a view that is
 * recreated destructively all fail here rather than on a customer's data.
 */

let work: string;
let dbPath: string;

function schemaOf(db: import('better-sqlite3').Database): string[] {
  return (
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as { type: string; name: string; sql: string | null }[]
  ).map((row) => `${row.type} ${row.name}: ${row.sql ?? ''}`);
}

function census(db: import('better-sqlite3').Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  }
  return counts;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'upgrade-'));
  dbPath = join(work, 'data.db');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('upgrading an existing installation', () => {
  it('re-opens a populated database without changing the schema or losing rows', () => {
    const db = openDb(dbPath);
    seed(db, join(work, "documents"));
    const schema = schemaOf(db);
    const before = census(db);
    expect(Object.values(before).some((n) => n > 0), 'the seed produced no rows').toBe(true);
    db.close();

    // What a redeploy does: the same code opens the same file again.
    const reopened = openDb(dbPath);
    expect(schemaOf(reopened)).toEqual(schema);
    expect(census(reopened)).toEqual(before);
    reopened.close();
  });

  it('survives being opened repeatedly, as a restart loop would', () => {
    const db = openDb(dbPath);
    seed(db, join(work, "documents"));
    const before = census(db);
    db.close();

    for (let i = 0; i < 3; i += 1) {
      const again = openDb(dbPath);
      expect(census(again)).toEqual(before);
      again.close();
    }
  });
});
