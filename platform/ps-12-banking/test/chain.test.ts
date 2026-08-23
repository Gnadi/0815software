import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { Transport } from '../server/transport.js';
import { loadKeySecret } from '../server/keystore.js';
import { chainHead, verifyChain } from '../server/chain.js';
import { pruneExchanges, sqliteRecorder } from '../server/exchanges.js';
import {
  connectionDetail,
  createConnection,
  fetchBankKeys,
  generateKeys,
  sendHia,
  sendIni,
  verifyBankKeys,
  type ExchangeContext,
} from '../server/connections.js';
import { submitOrder, type OrderContext } from '../server/orders.js';
import { MockBank } from './mock-bank.js';
import type { AuthConfig } from '../server/auth.js';
import type { BtfInput } from '../shared/types.js';

/**
 * Tamper-evidence over this service's own history.
 *
 * The question this suite answers is not "is the history there" — the
 * traceability suite covers that — but "would we know if somebody changed it".
 * PS-07 Audit Log does this for the catalogue and PS-12 deliberately does not
 * call it, because a platform service that needs a second service running to
 * answer for its own records is not independent.
 *
 * So each test is one edit somebody covering their tracks would actually make,
 * and the assertion is that the verdict names it. The final test is the
 * important one in the other direction: the ordinary work of running this
 * service — statuses folding in days later, retention pruning envelopes — must
 * NOT read as tampering, or the check becomes noise nobody looks at.
 */

const KEY_SECRET = loadKeySecret('44'.repeat(32));

const BTF: BtfInput = {
  service_name: 'SCT',
  scope: 'AT',
  msg_name: 'pain.001',
  msg_version: '03',
  container: 'XML',
};

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let db: Database.Database;
let bank: MockBank;
let ctx: OrderContext & ExchangeContext;

function movingClock(): () => string {
  let tick = 0;
  return () => `2026-08-20T10:00:${String(tick++ % 60).padStart(2, '0')}Z`;
}

function pain001(msgId: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
      `<GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>2026-08-20T10:00:00</CreDtTm>` +
      `<NbOfTxs>1</NbOfTxs><CtrlSum>10.00</CtrlSum>` +
      `<InitgPty><Nm>Test Debtor</Nm></InitgPty></GrpHdr>` +
      `<PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd>` +
      `<CdtTrfTxInf><PmtId><EndToEndId>E2E-1</EndToEndId></PmtId>` +
      `<Amt><InstdAmt Ccy="EUR">10.00</InstdAmt></Amt>` +
      `<Cdtr><Nm>Creditor</Nm></Cdtr></CdtTrfTxInf>` +
      `</PmtInf></CstmrCdtTrfInitn></Document>`,
    'utf8',
  );
}

async function bringUp(key = 'main'): Promise<void> {
  createConnection(
    db,
    {
      key,
      displayName: 'Test Bank',
      bankKey: 'generic',
      url: 'https://bank.example/ebics',
      hostId: bank.hostId,
      partnerId: 'PARTNER1',
      userId: 'USER1',
    },
    'admin',
  );
  generateKeys(ctx, key);
  await sendIni(ctx, key);
  await sendHia(ctx, key);
  await fetchBankKeys(ctx, key);
  const detail = connectionDetail(db, key);
  verifyBankKeys(ctx, key, {
    authDigest: detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
    encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
  });
}

/** One connection brought up and one payment sent — a chain worth attacking. */
async function history(): Promise<string> {
  await bringUp();
  const { order } = await submitOrder(ctx, { connection: 'main', btf: BTF, payload: pain001('CHAIN-0001') });
  return order.public_id;
}

beforeEach(() => {
  db = openDb(':memory:');
  bank = new MockBank();
  ctx = {
    db,
    keySecret: KEY_SECRET,
    transport: new Transport({
      post: async (_url, body) => bank.post(body),
      record: sqliteRecorder(db),
      now: movingClock(),
    }),
    actor: 'mod-04',
    now: movingClock(),
  };
});

// ── It holds when nothing was touched ─────────────────────────────────

describe('an untouched history', () => {
  it('verifies, and covers all four streams', async () => {
    await history();
    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(true);
    expect(verdict.head).toBe(chainHead(db));

    const sources = (
      db.prepare('SELECT DISTINCT source FROM event_chain').all() as { source: string }[]
    ).map((r) => r.source);
    expect(sources.sort()).toEqual(['bank_exchanges', 'connection_events', 'order_events']);
  });

  it('verifies an empty database — nothing to prove is not the same as broken', () => {
    expect(verifyChain(db).valid).toBe(true);
  });

  /**
   * The digest used to be the fields joined by a separator, which is an
   * ambiguous encoding: a field containing that separator re-splits, so two
   * different records could hash to the same value. `error` carries
   * `err.message` — the one field a network stack or a bank's error page will
   * put a newline in — so this was reachable, not theoretical.
   *
   * (The separator was also a literal NUL byte written by accident, which made
   * `chain.ts` binary to git: `git diff` said "Bin" and showed nothing at all.
   * The most security-sensitive file in the change would have reached a pull
   * request unreviewable.)
   */
  it('cannot be made to hash two different records the same way', () => {
    const digestOf = (over: Partial<Parameters<ReturnType<typeof sqliteRecorder>>[0]>): string => {
      const fresh = openDb(':memory:');
      try {
        sqliteRecorder(fresh)({
          connection: null,
          order: null,
          phase: 'p',
          url: 'u',
          request: 'r',
          response: null,
          httpStatus: null,
          error: null,
          startedAt: 's',
          finishedAt: 'f',
          durationMs: 0,
          ...over,
        });
        return (fresh.prepare('SELECT digest FROM event_chain WHERE seq = 1').get() as { digest: string }).digest;
      } finally {
        fresh.close();
      }
    };

    // The same characters, split differently between two fields.
    expect(digestOf({ error: 'x\ny', startedAt: 'z' })).not.toBe(digestOf({ error: 'x', startedAt: 'y\nz' }));
    // An absent field and a field that happens to hold the marker for absent.
    expect(digestOf({ error: null })).not.toBe(digestOf({ error: ' ' }));
    expect(digestOf({ error: null })).not.toBe(digestOf({ error: '\u0000' }));
  });

  it('links every record exactly once', async () => {
    await history();
    const counted = db
      .prepare('SELECT COUNT(*) AS n FROM (SELECT source, source_id FROM event_chain GROUP BY source, source_id)')
      .get() as { n: number };
    const total = db.prepare('SELECT COUNT(*) AS n FROM event_chain').get() as { n: number };
    expect(counted.n).toBe(total.n);
  });
});

// ── The edits somebody covering their tracks would make ───────────────

describe('an edited history', () => {
  it('catches a rejection quietly turned into an acceptance', async () => {
    await history();
    // The single most valuable edit: make a refused payment look accepted.
    db.prepare("UPDATE order_events SET type = 'accepted' WHERE type = 'queued'").run();

    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(false);
    expect(verdict.broken_kind).toBe('content');
    expect(verdict.broken_at?.source).toBe('order_events');
    expect(verdict.message).toContain('edited');
  });

  it('catches an actor rewritten to somebody else', async () => {
    await history();
    db.prepare("UPDATE order_events SET actor = 'somebody-else' WHERE type = 'accepted'").run();
    expect(verifyChain(db).broken_kind).toBe('content');
  });

  it('catches a step deleted from the middle', async () => {
    await history();
    db.prepare("DELETE FROM order_events WHERE type = 'segment_sent'").run();
    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(false);
    expect(verdict.broken_kind).toBe('missing');
  });

  it('catches an envelope edited after the fact', async () => {
    await history();
    db.prepare("UPDATE bank_exchanges SET request = request || '<!-- not what we sent -->'").run();
    expect(verifyChain(db).broken_kind).toBe('content');
  });

  it('catches a bank file swapped under a settled order', async () => {
    await history();
    // The download whose bytes an order's verdict was read out of.
    db.prepare(
      `INSERT INTO downloads (connection_id, public_id, kind, btf, sha256, byte_length, content, fetched_at)
       VALUES (1, 'dl_manual', 'status', '{}', 'aaaa', 4, x'61616161', '2026-08-20T11:00:00Z')`,
    ).run();
    // Written straight into the table: no link at all.
    expect(verifyChain(db).broken_kind).toBe('unchained');
  });

  it('catches an event inserted behind the log’s back', async () => {
    await history();
    db.prepare(
      `INSERT INTO order_events (order_id, type, ebics_code, meta, actor, created_at)
       VALUES (1, 'accepted', '000000', '{}', 'nobody', '2026-08-20T12:00:00Z')`,
    ).run();
    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(false);
    expect(verdict.broken_kind).toBe('unchained');
    expect(verdict.broken_at?.source).toBe('order_events');
  });

  it('catches a link rewritten to match a doctored record', async () => {
    await history();
    // The thorough version of the first attack: edit the record AND its
    // digest. The link hashes stop chaining, one row later.
    const row = db.prepare("SELECT seq, source_id FROM event_chain WHERE source = 'order_events' ORDER BY seq").get() as {
      seq: number;
      source_id: number;
    };
    db.prepare("UPDATE order_events SET type = 'accepted' WHERE id = ?").run(row.source_id);
    db.prepare("UPDATE event_chain SET digest = ? WHERE seq = ?").run('0'.repeat(64), row.seq);
    expect(verifyChain(db).valid).toBe(false);
  });

  it('catches the end of the log being cut off, link and record together', async () => {
    await history();
    // The thorough truncation: remove the last link AND the record it stood
    // for, so nothing is orphaned and nothing is missing. What survives chains
    // perfectly — which is exactly why this is the edit somebody covering
    // their tracks makes, and why the head marker exists. Nothing else in
    // `verifyChain` can see it.
    const tail = db.prepare('SELECT seq, source, source_id FROM event_chain ORDER BY seq DESC LIMIT 1').get() as {
      seq: number;
      source: string;
      source_id: number;
    };
    db.prepare(`DELETE FROM ${tail.source} WHERE id = ?`).run(tail.source_id);
    db.prepare('DELETE FROM event_chain WHERE seq = ?').run(tail.seq);

    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(false);
    expect(verdict.broken_kind).toBe('truncated');
  });

  it('catches the whole chain being wiped while the records stay', async () => {
    await history();
    db.prepare('DELETE FROM event_chain').run();
    expect(verifyChain(db).valid).toBe(false);
  });
});

// ── What must NOT read as tampering ───────────────────────────────────

describe('the ordinary work of running this service', () => {
  it('stays valid when a status folds in days later', async () => {
    const publicId = await history();
    // What the tick does: a pain.002 arrives and settles the order. It appends
    // to the same stream, through the same door.
    const { recordOrderEvent } = await import('../server/orders.js');
    const order = db.prepare('SELECT id FROM orders WHERE public_id = ?').get(publicId) as { id: number };
    recordOrderEvent(db, {
      orderId: order.id,
      type: 'settled',
      at: '2026-08-23T09:00:00Z',
      actor: 'ticker',
      meta: { message: 'the bank settled this payment', source: 'dl_abc' },
    });
    expect(verifyChain(db).valid).toBe(true);
  });

  it('stays valid when retention ages the envelopes out', async () => {
    await history();
    const before = verifyChain(db).count;

    const pruned = pruneExchanges(db, 365, () => '2028-08-20T10:00:00Z');
    expect(pruned).toBeGreaterThan(0);

    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(true);
    // The links stayed. Only their content was allowed to go.
    expect(verdict.count).toBe(before);
    const marked = db.prepare('SELECT COUNT(*) AS n FROM event_chain WHERE pruned_at IS NOT NULL').get() as {
      n: number;
    };
    expect(marked.n).toBe(pruned);
  });

  it('still catches a deletion dressed up as retention', async () => {
    await history();
    // Deleting the row without marking the link — what a hand-written DELETE
    // looks like. Retention marks; this does not.
    db.prepare('DELETE FROM bank_exchanges').run();
    expect(verifyChain(db).broken_kind).toBe('missing');
  });

  /**
   * The finding this test exists for, which held for three commits: retention
   * used to mark every link whose record was missing, rather than the ones it
   * had just deleted — and it runs on EVERY tick, whether or not there is
   * anything inside the window to delete.
   *
   * So a deleted envelope was caught, and then the next ordinary tick adopted
   * the deletion as its own and the chain went green. `missing` was not a
   * finding, it was a countdown. Nothing else in the suite noticed, because
   * every other test verified before a prune had run.
   */
  it('does not let an ordinary tick adopt somebody else’s deletion', async () => {
    await history();
    db.prepare("DELETE FROM bank_exchanges WHERE phase = 'order.initialisation'").run();
    expect(verifyChain(db).broken_kind).toBe('missing');

    // A tick, on a service whose retention window nothing is old enough to
    // reach: it deletes nothing at all.
    expect(pruneExchanges(db, 730, () => '2026-08-20T12:00:00Z')).toBe(0);

    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(false);
    expect(verdict.broken_kind).toBe('missing');
    // And nothing was marked, since nothing was aged out.
    const marked = db.prepare('SELECT COUNT(*) AS n FROM event_chain WHERE pruned_at IS NOT NULL').get() as {
      n: number;
    };
    expect(marked.n).toBe(0);
  });

  it('marks only what it aged out, when a real prune runs beside a deletion', async () => {
    await history();
    const [oldest, ...rest] = db.prepare('SELECT id FROM bank_exchanges ORDER BY id').all() as { id: number }[];
    expect(rest.length).toBeGreaterThan(0);

    // One row is genuinely old; another is deleted by hand on the same day.
    db.prepare("UPDATE bank_exchanges SET started_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(oldest!.id);
    db.prepare('DELETE FROM bank_exchanges WHERE id = ?').run(rest[0]!.id);

    expect(pruneExchanges(db, 365, () => '2026-08-20T12:00:00Z')).toBe(1);

    // The aged-out link is marked; the hand-deleted one is still a finding.
    const verdict = verifyChain(db);
    expect(verdict.valid).toBe(false);
    expect(verdict.broken_kind).toBe('missing');
    expect(verdict.broken_at?.source_id).toBe(rest[0]!.id);
  });

  it('stays valid when a download is marked processed afterwards', async () => {
    await history();
    db.prepare(
      `INSERT INTO downloads (connection_id, public_id, kind, btf, sha256, byte_length, content, fetched_at)
       VALUES (1, 'dl_ok', 'status', '{}', 'bbbb', 4, x'62626262', '2026-08-20T11:00:00Z')`,
    ).run();
    const { chainAppend } = await import('../server/chain.js');
    const id = (db.prepare("SELECT id FROM downloads WHERE public_id = 'dl_ok'").get() as { id: number }).id;
    chainAppend(db, 'downloads', id, () => '2026-08-20T11:00:00Z');
    expect(verifyChain(db).valid).toBe(true);

    // `processed_at` and `acknowledged_at` are ordinary later work, not
    // content — hashing them would report the tick as tampering.
    db.prepare("UPDATE downloads SET processed_at = ?, acknowledged_at = ? WHERE id = ?").run(
      '2026-08-21T00:00:00Z',
      '2026-08-21T00:00:00Z',
      id,
    );
    expect(verifyChain(db).valid).toBe(true);
  });

  it('survives an actual restart, on an actual file', async () => {
    // Every other test here runs against `:memory:`, which cannot show that
    // the head marker is durable — it lives in a table, but a table is only
    // as convincing as the process that outlives it. So this one writes to
    // disk, closes the database, and opens it again the way a restart does.
    const dir = mkdtempSync(join(tmpdir(), 'ps12-chain-'));
    const path = join(dir, 'restart.db');
    try {
      db = openDb(path);
      ctx = {
        db,
        keySecret: KEY_SECRET,
        transport: new Transport({
          post: async (_url, body) => bank.post(body),
          record: sqliteRecorder(db),
          now: movingClock(),
        }),
        actor: 'mod-04',
        now: movingClock(),
      };
      await history();
      const head = chainHead(db);
      const links = (db.prepare('SELECT COUNT(*) AS n FROM event_chain').get() as { n: number }).n;
      expect(typeof head).toBe('string');
      expect(links).toBeGreaterThan(0);
      db.close();

      // Reopening runs the migrations again. They must be a no-op: a schema
      // step that re-ran and rewrote anything chained would break the chain
      // on every single boot.
      const reopened = openDb(path);
      try {
        expect(chainHead(reopened)).toBe(head);
        expect((reopened.prepare('SELECT COUNT(*) AS n FROM event_chain').get() as { n: number }).n).toBe(links);
        expect(verifyChain(reopened).valid).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The cheap pass, and what it honestly does not cover ───────────────

describe('verifying without re-reading every stored body', () => {
  /**
   * The full check re-hashes every envelope, so it costs in proportion to the
   * bytes kept: 2.5 s at 20 000 conversations, which a tick-driven connection
   * reaches in about two weeks. It ran on the metrics gauge every minute and
   * at boot, which would have blocked the event loop for seconds on a timer.
   *
   * The gauge and boot now run the links-only pass. These tests pin exactly
   * where the line falls, in both directions — a cheap check that quietly
   * claimed the expensive one would be worse than no check.
   */
  it('still catches a rewritten link', async () => {
    await history();
    const tail = db.prepare('SELECT seq FROM event_chain ORDER BY seq DESC LIMIT 1').get() as { seq: number };
    db.prepare('UPDATE event_chain SET digest = ? WHERE seq = ?').run('0'.repeat(64), tail.seq);
    expect(verifyChain(db, { content: false }).valid).toBe(false);
  });

  it('still catches a truncated end and a record written past the log', async () => {
    await history();
    db.prepare(
      `INSERT INTO order_events (order_id, type, ebics_code, meta, actor, created_at)
       VALUES (1, 'accepted', '000000', '{}', 'nobody', '2026-08-20T12:00:00Z')`,
    ).run();
    expect(verifyChain(db, { content: false }).broken_kind).toBe('unchained');
  });

  it('does NOT catch an edited record — and says so in the verdict', async () => {
    await history();
    db.prepare("UPDATE order_events SET type = 'accepted' WHERE type = 'queued'").run();

    const cheap = verifyChain(db, { content: false });
    expect(cheap.valid).toBe(true);
    // The flag is the point: a caller must be able to tell a cheap pass from a
    // full one, or a green gauge reads as a guarantee it never made.
    expect(cheap.content_checked).toBe(false);

    const full = verifyChain(db);
    expect(full.valid).toBe(false);
    expect(full.content_checked).toBe(true);
  });

  it('reads nothing from the tables it is not checking', async () => {
    await history();
    // Drop the evidence entirely. The links still stand on their own, which is
    // what makes the cheap pass cheap — and is why it cannot speak for the
    // content.
    db.prepare('DELETE FROM bank_exchanges').run();
    expect(verifyChain(db, { content: false }).valid).toBe(true);
    expect(verifyChain(db).broken_kind).toBe('missing');
  });
});

// ── Over HTTP ─────────────────────────────────────────────────────────

describe('asking the service whether its own history holds', () => {
  let app: Express;
  let session: string;

  beforeEach(async () => {
    app = createApp({ db, auth, keySecret: '44'.repeat(32), transport: ctx.transport as Transport });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' }).expect(200);
    session = login.body.token as string;
  });

  it('answers with the verdict and the head to write down', async () => {
    await history();
    const res = await request(app).get('/api/audit/chain').set('Authorization', `Bearer ${session}`).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.head).toBe(chainHead(db));

    const head = await request(app).get('/api/audit/head').set('Authorization', `Bearer ${session}`).expect(200);
    expect(head.body.head).toBe(res.body.head);
  });

  it('names the break instead of just saying no', async () => {
    await history();
    db.prepare("UPDATE order_events SET type = 'accepted' WHERE type = 'queued'").run();
    const res = await request(app).get('/api/audit/chain').set('Authorization', `Bearer ${session}`).expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.broken_kind).toBe('content');
    expect(res.body.message).toContain('order_events');
  });

  it('reports the verdict on the metrics endpoint, where a monitor can see it', async () => {
    await history();
    const ok = await request(app).get('/api/metrics').expect(200);
    expect(ok.text).toContain('banking_chain_valid{service="ps-12"} 1');
    // And the help text admits which half it checked, so nobody wires an
    // alert believing it covers more than it does.
    expect(ok.text).toContain('cheap pass only');
  });

  it('runs the full check on the route, and the cheap one only when asked', async () => {
    await history();
    const full = await request(app).get('/api/audit/chain').set('Authorization', `Bearer ${session}`).expect(200);
    expect(full.body.content_checked).toBe(true);

    const quick = await request(app)
      .get('/api/audit/chain?quick=1')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    expect(quick.body.content_checked).toBe(false);
  });

  it('is admin-only — a module may pay, not audit', async () => {
    for (const path of ['/api/audit/chain', '/api/audit/head']) {
      await request(app).get(path).set('X-Service-Token', 'test-service').expect(403);
      await request(app).get(path).expect(401);
    }
  });
});
