import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { Transport } from '../server/transport.js';
import { loadKeySecret, KeyStoreError, assertKeyStoreReadable } from '../server/keystore.js';
import {
  connectionDetail,
  createConnection,
  clearFailure,
  fetchBankKeys,
  generateKeys,
  listConnections,
  probeVersions,
  requireReady,
  resume,
  sendHia,
  sendIni,
  sendSpr,
  suspend,
  verifyBankKeys,
  type ExchangeContext,
} from '../server/connections.js';
import { DomainError } from '../server/errors.js';
import { MockBank } from './mock-bank.js';

/**
 * The key exchange, end to end against a bank that actually checks its input.
 *
 * The property this suite exists for is the one the protocol cannot provide on
 * its own: **a connection becomes usable only when a human has confirmed the
 * bank's key digests.** Everything else here is the machinery that gets to
 * that point, and the tests that a step out of order is refused.
 */

const KEY_SECRET = loadKeySecret('11'.repeat(32));

let db: Database.Database;
let bank: MockBank;
let ctx: ExchangeContext;

/** Timestamps come from a counter, so envelopes stay reproducible. */
function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-19T09:${String(tick++).padStart(2, '0')}:00Z`;
}

function connect(overrides: Record<string, unknown> = {}): void {
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
      ...overrides,
    },
    'admin',
  );
}

/** Walk a connection all the way to `ready`, the way an operator would. */
async function bringUp(): Promise<void> {
  connect();
  generateKeys(ctx, 'main');
  await sendIni(ctx, 'main');
  await sendHia(ctx, 'main');
  await fetchBankKeys(ctx, 'main');
  const detail = connectionDetail(db, 'main');
  verifyBankKeys(ctx, 'main', {
    authDigest: detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted,
    encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  bank = new MockBank();
  ctx = {
    db,
    keySecret: KEY_SECRET,
    transport: new Transport({ post: async (_url, body) => bank.post(body) }),
    actor: 'admin',
    now: fixedClock(),
  };
});

describe('recovering from a failure during setup', () => {
  /**
   * Point the connection at a bank that has never seen our INI.
   *
   * Not contrived: this is what a bank looks like before it has processed the
   * posted INI letter, and its answer is a real EBICS verdict (091002,
   * "subscriber unknown or not yet activated") rather than a transport error.
   * A verdict is what records a `failed` event — a timeout deliberately does
   * not, because nothing happened.
   */
  function bankHasNotActivatedUsYet(): MockBank {
    const stranger = new MockBank();
    ctx.transport = new Transport({ post: async (_url, body) => stranger.post(body) });
    return stranger;
  }

  it('records the failure rather than pretending the step worked', async () => {
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    bankHasNotActivatedUsYet();

    await expect(fetchBankKeys(ctx, 'main')).rejects.toThrow(/091002|subscriber/);
    const detail = connectionDetail(db, 'main');
    expect(detail.state).toBe('failed');
    expect(detail.events.at(-1)).toMatchObject({ type: 'failed' });
  });

  it('leaves the state alone when the bank simply could not be reached', async () => {
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    ctx.transport = new Transport({
      post: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    });

    // A timeout is not a refusal: nothing happened, so nothing is recorded and
    // the operator can simply try again.
    await expect(fetchBankKeys(ctx, 'main')).rejects.toThrow(/ETIMEDOUT/);
    expect(connectionDetail(db, 'main').state).toBe('hia_sent');
  });

  it('can be cleared back to the last completed step, and retried', async () => {
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    const honest = ctx.transport;
    bankHasNotActivatedUsYet();
    await expect(fetchBankKeys(ctx, 'main')).rejects.toThrow();

    // Before this existed, a transient bank error ended the connection: every
    // route answered 409, the key is UNIQUE and there is no delete, so the
    // only way out was editing the database by hand.
    const cleared = clearFailure(ctx, 'main');
    expect(cleared.state).toBe('hia_sent');

    ctx.transport = honest;
    await fetchBankKeys(ctx, 'main');
    expect(connectionDetail(db, 'main').state).toBe('hpb_fetched');
  });

  it('never clears FORWARD — a failure is not a route to `ready`', async () => {
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    await fetchBankKeys(ctx, 'main');
    bankHasNotActivatedUsYet();
    // Fail from `hpb_fetched`, then clear.
    await expect(fetchBankKeys(ctx, 'main')).rejects.toThrow();
    expect(clearFailure(ctx, 'main').state).toBe('hpb_fetched');
    // Still not usable: the human step has not happened.
    expect(() => requireReady(db, 'main')).toThrow(/nobody has confirmed/);
  });

  it('refuses to clear a connection that has not failed', () => {
    connect();
    expect(() => clearFailure(ctx, 'main')).toThrow(/not failed/);
  });
});

describe('creating a connection', () => {
  it('starts in `created`, with no keys of any kind', () => {
    connect();
    const detail = connectionDetail(db, 'main');
    expect(detail.state).toBe('created');
    expect(detail.keys).toEqual([]);
    expect(detail.bank_keys).toEqual([]);
    expect(detail.events.map((e) => e.type)).toEqual(['created']);
  });

  it('refuses a duplicate key, and 404s on an unknown one', () => {
    connect();
    expect(() => connect()).toThrow(/already exists/);
    expect(() => connectionDetail(db, 'nope')).toThrow(DomainError);
  });

  it('carries ceilings, because a signed order is money gone', () => {
    connect({ key: 'capped', maxAmountMinor: 50_000, maxTransfers: 10 });
    const detail = connectionDetail(db, 'capped');
    expect(detail.max_amount_minor).toBe(50_000);
    expect(detail.max_transfers).toBe(10);
  });
});

describe('generating our keys', () => {
  it('creates exactly three, and shows digests rather than key material', () => {
    connect();
    const detail = generateKeys(ctx, 'main');
    expect(detail.state).toBe('keys_generated');
    expect(detail.keys.map((k) => `${k.purpose}/${k.version}`).sort()).toEqual([
      'AUTH/X002',
      'ENC/E002',
      'ES/A005',
    ]);
    for (const key of detail.keys) {
      expect(key.digest).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(key.digestFormatted).toMatch(/^[0-9A-F]{8}( [0-9A-F]{8})+$/);
      expect(JSON.stringify(key)).not.toContain('PRIVATE KEY');
    }
  });

  it('honours the A006 signature version when the connection asks for it', () => {
    connect({ key: 'pss', esVersion: 'A006' });
    const detail = generateKeys(ctx, 'pss');
    expect(detail.keys.find((k) => k.purpose === 'ES')!.version).toBe('A006');
  });

  it('refuses a second generation — it would orphan the bank’s copy', () => {
    connect();
    generateKeys(ctx, 'main');
    expect(() => generateKeys(ctx, 'main')).toThrow(/only be generated once/);
  });

  it('keeps private keys out of the detail payload entirely', () => {
    connect();
    generateKeys(ctx, 'main');
    const serialised = JSON.stringify(connectionDetail(db, 'main'));
    expect(serialised).not.toContain('PRIVATE');
    expect(serialised).not.toContain('BEGIN');
  });
});

describe('the exchange, in order', () => {
  it('walks created → keys → INI → HIA → HPB → ready', async () => {
    await bringUp();
    const detail = connectionDetail(db, 'main');
    expect(detail.state).toBe('ready');
    expect(detail.events.map((e) => e.type)).toEqual([
      'created',
      'keys_generated',
      'ini_sent',
      'hia_sent',
      'hpb_fetched',
      'bank_keys_verified',
    ]);
  });

  it('refuses every step taken out of turn', async () => {
    connect();
    await expect(sendIni(ctx, 'main')).rejects.toThrow(/fresh keys/);
    generateKeys(ctx, 'main');
    await expect(sendHia(ctx, 'main')).rejects.toThrow(/HIA follows INI/);
    await expect(fetchBankKeys(ctx, 'main')).rejects.toThrow(/HPB follows HIA/);
    await sendIni(ctx, 'main');
    await expect(fetchBankKeys(ctx, 'main')).rejects.toThrow(/HPB follows HIA/);
  });

  it('is refused by the bank when HPB is asked before initialisation', async () => {
    // The mock enforces this the way a real bank does, so a client that
    // reordered the exchange would fail here rather than in production.
    const impatient = new MockBank();
    const otherDb = openDb(':memory:');
    const otherCtx: ExchangeContext = {
      db: otherDb,
      keySecret: KEY_SECRET,
      transport: new Transport({ post: async (_u, body) => impatient.post(body) }),
      now: fixedClock(),
    };
    createConnection(otherDb, {
      key: 'x', displayName: 'x', bankKey: 'generic', url: 'https://bank.example/ebics',
      hostId: impatient.hostId, partnerId: 'P', userId: 'U',
    });
    generateKeys(otherCtx, 'x');
    // Reach HPB's precondition without the bank knowing us: send INI and HIA
    // to a DIFFERENT bank instance, then ask this one for its keys.
    await sendIni(otherCtx, 'x');
    await sendHia(otherCtx, 'x');
    const stranger = new MockBank();
    otherCtx.transport = new Transport({ post: async (_u, body) => stranger.post(body) });
    await expect(fetchBankKeys(otherCtx, 'x')).rejects.toThrow(/subscriber unknown/);
    expect(connectionDetail(otherDb, 'x').state).toBe('failed');
  });

  it('probes the versions a bank speaks', async () => {
    connect();
    const result = await probeVersions(ctx, 'main');
    expect(result.hostId).toBe(bank.hostId);
    expect(result.versions).toContainEqual({ protocol: 'H005', revision: '03.00' });
  });

  it('signs every secured request — the bank verifies and would refuse otherwise', async () => {
    await bringUp();
    // The mock verifies the AuthSignature on HPB and on every upload; reaching
    // `ready` at all is proof the signatures held.
    expect(bank.requests.some((r) => r.includes('AuthSignature'))).toBe(true);
  });
});

describe('confirming the bank’s keys — the step that is a human, not a protocol', () => {
  async function toHpb(): Promise<void> {
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    await fetchBankKeys(ctx, 'main');
  }

  it('does NOT make the connection usable on its own', async () => {
    await toHpb();
    const detail = connectionDetail(db, 'main');
    expect(detail.state).toBe('hpb_fetched');
    expect(detail.bank_keys.every((k) => k.verified_at === null)).toBe(true);
    expect(() => requireReady(db, 'main')).toThrow(/nobody has confirmed them/);
  });

  it('accepts the digests as printed, whatever the spacing', async () => {
    await toHpb();
    const detail = connectionDetail(db, 'main');
    const auth = detail.bank_keys.find((k) => k.purpose === 'AUTH')!.digestFormatted;
    const enc = detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted;
    // An operator copying off a page may not reproduce the grouping exactly.
    const confirmed = verifyBankKeys(ctx, 'main', {
      authDigest: auth.toLowerCase().replace(/ /g, ''),
      encDigest: enc.replace(/ /g, ':'),
    });
    expect(confirmed.state).toBe('ready');
    expect(confirmed.bank_keys.every((k) => k.verified_at !== null)).toBe(true);
    expect(confirmed.bank_keys[0]!.verified_by).toBe('admin');
  });

  it('REFUSES a digest that does not match, and records the attempt', async () => {
    await toHpb();
    const detail = connectionDetail(db, 'main');
    expect(() =>
      verifyBankKeys(ctx, 'main', {
        authDigest: '00000000 11111111 22222222 33333333 44444444 55555555 66666666 77777777',
        encDigest: detail.bank_keys.find((k) => k.purpose === 'ENC')!.digestFormatted,
      }),
    ).toThrow(/do not match/);

    const after = connectionDetail(db, 'main');
    expect(after.state).toBe('hpb_fetched'); // still unusable
    expect(after.events.map((e) => e.type)).toContain('bank_keys_rejected');
    expect(() => requireReady(db, 'main')).toThrow();
  });

  it('clears the confirmation when the keys are fetched again', async () => {
    await bringUp();
    expect(connectionDetail(db, 'main').state).toBe('ready');

    // A second HPB brings potentially DIFFERENT keys. Inheriting the old tick
    // would let a substituted key wear a human's approval.
    await fetchBankKeys(ctx, 'main');
    const detail = connectionDetail(db, 'main');
    expect(detail.state).toBe('hpb_fetched');
    expect(detail.bank_keys.every((k) => k.verified_at === null)).toBe(true);
    expect(() => requireReady(db, 'main')).toThrow();
  });

  it('refuses confirmation when there is nothing freshly fetched', () => {
    connect();
    expect(() => verifyBankKeys(ctx, 'main', { authDigest: 'x', encDigest: 'y' })).toThrow(/no freshly fetched/);
  });
});

describe('suspending and resuming', () => {
  it('stops orders while suspended, and needs verified keys to come back', async () => {
    await bringUp();
    expect(requireReady(db, 'main').key).toBe('main');

    suspend(ctx, 'main', 'bank contract under review');
    expect(connectionDetail(db, 'main').state).toBe('suspended');
    expect(() => requireReady(db, 'main')).toThrow(/suspended/);

    resume(ctx, 'main');
    expect(connectionDetail(db, 'main').state).toBe('ready');
  });

  it('records why it was suspended', async () => {
    await bringUp();
    suspend(ctx, 'main', 'keys compromised');
    const event = connectionDetail(db, 'main').events.find((e) => e.type === 'suspended')!;
    expect(event.meta.reason).toBe('keys compromised');
    expect(() => suspend(ctx, 'main', 'again')).toThrow(/already suspended/);
  });
});

describe('the key store', () => {
  it('passes the boot check on an empty database', () => {
    expect(() => assertKeyStoreReadable(db, KEY_SECRET)).not.toThrow();
  });

  it('passes with the secret that wrote the keys', () => {
    connect();
    generateKeys(ctx, 'main');
    expect(() => assertKeyStoreReadable(db, KEY_SECRET)).not.toThrow();
  });

  it('REFUSES TO BOOT under a rotated secret, naming the recovery', () => {
    // This is the provisioning hazard made loud: `deploy/provision.mjs`
    // generates a fresh value for every secret on every provision, so a
    // re-provision of a live stack rotates this one.
    connect();
    generateKeys(ctx, 'main');
    const rotated = loadKeySecret('22'.repeat(32));
    expect(() => assertKeyStoreReadable(db, rotated)).toThrow(KeyStoreError);
    expect(() => assertKeyStoreReadable(db, rotated)).toThrow(/re-initialised with the bank/);
  });

  it('refuses a malformed secret outright', () => {
    expect(() => loadKeySecret('too short')).toThrow(/64 hex characters/);
  });
});

describe('listing', () => {
  it('shows each connection with its folded state', async () => {
    await bringUp();
    connect({ key: 'second' });
    const all = listConnections(db);
    expect(all.map((c) => [c.key, c.state])).toEqual([
      ['main', 'ready'],
      ['second', 'created'],
    ]);
  });
});

// ── SPR: the bank locks the subscriber ────────────────────────────────

describe('locking the subscriber at the bank', () => {
  /** Everything up to HPB, without the human confirmation that follows it. */
  async function upToHpb(): Promise<void> {
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    await fetchBankKeys(ctx, 'main');
  }

  // At signature class E the private ES key can move money on its own, so
  // "stop it right now" has to have an answer that is not "ring the bank".
  it('locks a ready connection, and the bank forgets the subscriber', async () => {
    await bringUp();
    const detail = await sendSpr(ctx, 'main', 'key possibly copied from a laptop');

    expect(detail.state).toBe('locked');
    expect(bank.locked.size).toBe(1);
    expect(detail.events.at(-1)!.type).toBe('locked');
    expect(detail.events.at(-1)!.meta.reason).toBe('key possibly copied from a laptop');
  });

  it('refuses orders afterwards, naming the only way back', async () => {
    await bringUp();
    await sendSpr(ctx, 'main', 'incident');
    // Not "suspended" — nothing in this service can undo a bank-side lock, and
    // an operator reading the error needs to know that before they go hunting
    // for a resume button that does not exist.
    expect(() => requireReady(db, 'main')).toThrow(/locked this subscriber/);
    expect(() => requireReady(db, 'main')).toThrow(/INI and HIA again/);
  });

  it('cannot be resumed, cleared or suspended out of', async () => {
    await bringUp();
    await sendSpr(ctx, 'main', 'incident');

    // This is the whole difference between `locked` and `suspended`: a local
    // decision is reversible here, the bank's is not.
    expect(() => resume(ctx, 'main')).toThrow(/locked this subscriber/);
    expect(() => clearFailure(ctx, 'main')).toThrow(/locked this subscriber/);
    expect(() => suspend(ctx, 'main', 'anything')).toThrow(/locked this subscriber/);
  });

  it('does NOT record a lock the bank refused', async () => {
    // The dangerous failure is a green tick over nothing: an operator hits
    // lock during an incident, believes the key is dead, and walks away.
    await bringUp();
    bank.configure({ refuseSpr: true });
    await expect(sendSpr(ctx, 'main', 'incident')).rejects.toThrow(/NOT locked/);

    const detail = connectionDetail(db, 'main');
    expect(detail.state).toBe('failed');
    expect(detail.events.at(-1)!.meta.step).toBe('spr');
    expect(bank.locked.size).toBe(0);
  });

  it('cannot be sent before HPB, because it needs the bank’s keys', async () => {
    // SPR is a fully protected ebicsRequest: it encrypts to the bank's key and
    // carries digests of it. Before HPB there is nothing to encrypt to.
    connect();
    generateKeys(ctx, 'main');
    await sendIni(ctx, 'main');
    await sendHia(ctx, 'main');
    await expect(sendSpr(ctx, 'main', 'incident')).rejects.toThrow(/hia_sent/);
  });

  it('does not require the bank keys to have been CONFIRMED', async () => {
    // Verification protects us from a substituted bank key. In an incident,
    // locking with the keys on hand beats not locking; if they were
    // substituted the lock simply does not take and the bank's answer says so.
    await upToHpb();
    expect(connectionDetail(db, 'main').state).toBe('hpb_fetched');
    const detail = await sendSpr(ctx, 'main', 'incident');
    expect(detail.state).toBe('locked');
  });

  it('refuses a second lock rather than pretending', async () => {
    await bringUp();
    await sendSpr(ctx, 'main', 'incident');
    await expect(sendSpr(ctx, 'main', 'again')).rejects.toThrow(/already locked/);
  });
});
