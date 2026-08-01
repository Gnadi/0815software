import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '../server/db.js';
import { pendingCount, runMigrations } from '../server/migrations.js';
import { seed } from '../server/seed.js';
/**
 * Upgrading a customer runs this service's migrations over a database that is
 * already full of their data. An empty database proves nothing about that: the
 * failure mode is a step that works on an empty table and drops rows from a
 * populated one — a table rebuild that forgets to copy, an ALTER that is not
 * really guarded.
 *
 * So this seeds real data, forgets which migrations were applied, and replays
 * every one of them over it. Nothing may be lost and nothing may be left
 * pending.
 */

/** Row counts for every table the service owns, keyed by table name. */
function census(db: import('better-sqlite3').Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  }
  return counts;
}

describe('upgrading an existing installation', () => {
  it('replays every migration over seeded data without losing any of it', () => {
    const db = openDb(':memory:');
    seed(db);

    const before = census(db);
    expect(Object.keys(before).length, 'the seed produced no tables').toBeGreaterThan(0);
    expect(Object.values(before).some((n) => n > 0), 'the seed produced no rows').toBe(true);

    // Pretend this database predates every migration, which is what an old
    // installation looks like to a new build.
    db.prepare('DELETE FROM schema_migrations').run();
    expect(pendingCount(db, MIGRATIONS)).toBe(MIGRATIONS.length);

    runMigrations(db, MIGRATIONS);

    expect(pendingCount(db, MIGRATIONS)).toBe(0);
    expect(census(db)).toEqual(before);
    db.close();
  });

  it('applies migrations one at a time to the same schema as applying them at once', () => {
    const stepwise = openDb(':memory:');
    stepwise.prepare('DELETE FROM schema_migrations').run();
    for (const migration of MIGRATIONS) runMigrations(stepwise, [migration]);

    const oneShot = openDb(':memory:');

    const schemaOf = (db: import('better-sqlite3').Database): string[] =>
      (
        db
          .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
          .all() as { type: string; name: string; sql: string | null }[]
      ).map((row) => `${row.type} ${row.name}: ${row.sql ?? ''}`);

    expect(schemaOf(stepwise)).toEqual(schemaOf(oneShot));
    stepwise.close();
    oneShot.close();
  });

  it('is a no-op when everything is already applied', () => {
    const db = openDb(':memory:');
    expect(runMigrations(db, MIGRATIONS)).toBe(0);
    expect(pendingCount(db, MIGRATIONS)).toBe(0);
    db.close();
  });
});
