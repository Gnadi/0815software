import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '../server/db.js';
import { verifyChain } from '../server/chain.js';
import { pendingCount, runMigrations } from '../server/migrations.js';
import { Transport } from '../server/transport.js';
import { loadKeySecret } from '../server/keystore.js';
import {
  connectionDetail,
  createConnection,
  fetchBankKeys,
  generateKeys,
  sendHia,
  sendIni,
  verifyBankKeys,
} from '../server/connections.js';
import { submitOrder } from '../server/orders.js';
import { MockBank } from './mock-bank.js';
/**
 * Upgrading a customer runs this service's migrations over a database that is
 * already full of their data. An empty database proves nothing about that: the
 * failure mode is a step that works on an empty table and drops rows from a
 * populated one — a table rebuild that forgets to copy, an ALTER that is not
 * really guarded.
 *
 * So this fills a database, forgets which migrations were applied, and replays
 * every one of them over it. Nothing may be lost and nothing may be left
 * pending.
 *
 * The data is built by driving the service rather than by calling `seed`,
 * because this service deliberately seeds nothing — a bank connection only
 * becomes real through a key exchange with an actual bank. Driving the mock
 * bank fills every table the migrations touch, which is what the test needs.
 */

/** A connection carried all the way to `ready`, with one accepted order. */
async function fill(db: import('better-sqlite3').Database): Promise<void> {
  const bank = new MockBank();
  const ctx = {
    db,
    keySecret: loadKeySecret('44'.repeat(32)),
    transport: new Transport({ post: async (_url: string, body: string) => bank.post(body) }),
    actor: 'admin',
  };
  createConnection(
    db,
    {
      key: 'main',
      displayName: 'Test Bank',
      bankKey: 'generic',
      url: 'https://bank.example/ebics',
      hostId: bank.hostId,
      partnerId: 'PARTNER1',
      userId: 'USER1',
    },
    'admin',
  );
  generateKeys(ctx, 'main');
  await sendIni(ctx, 'main');
  await sendHia(ctx, 'main');
  await fetchBankKeys(ctx, 'main');
  const detail = connectionDetail(db, 'main');
  verifyBankKeys(ctx, 'main', {
    authDigest: detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
    encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
  });

  await submitOrder(ctx, {
    connection: 'main',
    btf: { service_name: 'SCT', scope: 'AT', msg_name: 'pain.001', msg_version: '03', container: 'XML' },
    payload: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>' +
        '<GrpHdr><MsgId>UPGRADE-1</MsgId><NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum></GrpHdr>' +
        '<PmtInf><CdtTrfTxInf><Amt><InstdAmt Ccy="EUR">10.00</InstdAmt></Amt></CdtTrfTxInf></PmtInf>' +
        '</CstmrCdtTrfInitn></Document>',
      'utf8',
    ),
    idempotencyKey: 'upgrade-1',
  });
}

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
  it('replays every migration over a populated database without losing any of it', async () => {
    const db = openDb(':memory:');
    await fill(db);

    const before = census(db);
    expect(Object.keys(before).length, 'no tables were created').toBeGreaterThan(0);
    expect(Object.values(before).some((n) => n > 0), 'no rows were written').toBe(true);

    // Pretend this database predates every migration, which is what an old
    // installation looks like to a new build.
    db.prepare('DELETE FROM schema_migrations').run();
    expect(pendingCount(db, MIGRATIONS)).toBe(MIGRATIONS.length);

    runMigrations(db, MIGRATIONS);

    expect(pendingCount(db, MIGRATIONS)).toBe(0);
    expect(census(db)).toEqual(before);

    // The chain was backfilled over records that predate it, and the replay
    // did not double-link any of them. It attests to what the database said at
    // upgrade time and no more — `server/chain.ts` says so where a reader of a
    // green verdict will find it — but it must at least hold.
    expect(verifyChain(db).valid).toBe(true);
    db.close();
  });

  /**
   * Migration 3 — which shipped, so it stays — drops and recreates `orders`
   * and copies `order_events` aside and back. Written with hard-coded column
   * lists, it silently emptied every column a LATER migration adds:
   * `ebics_order_id`, the reference the bank's own customer protocol keys on,
   * and `actor`, the record of who caused each step. Both survived a fresh
   * install and both vanished on a replay, with no error anywhere.
   *
   * The event chain is what made it visible: the digests stopped matching. The
   * assertion is here rather than there because the loss is the bug and the
   * chain only noticed. Squashing 7–18 into one migration did not remove the
   * hazard — the rebuild still runs before the migration that adds those
   * columns — so the fix and this test both stay.
   */
  it('keeps columns that later migrations added when the rebuild replays', async () => {
    const db = openDb(':memory:');
    await fill(db);
    db.prepare("UPDATE orders SET ebics_order_id = 'N001'").run();

    const before = {
      orderIds: db.prepare('SELECT id, ebics_order_id FROM orders ORDER BY id').all(),
      actors: db.prepare('SELECT id, actor FROM order_events ORDER BY id').all(),
    };
    expect(before.orderIds.length).toBeGreaterThan(0);
    expect(before.actors.some((r) => (r as { actor: string | null }).actor !== null)).toBe(true);

    db.prepare('DELETE FROM schema_migrations').run();
    runMigrations(db, MIGRATIONS);

    expect(db.prepare('SELECT id, ebics_order_id FROM orders ORDER BY id').all()).toEqual(before.orderIds);
    expect(db.prepare('SELECT id, actor FROM order_events ORDER BY id').all()).toEqual(before.actors);
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
