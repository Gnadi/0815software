import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { Transport } from '../server/transport.js';
import { loadKeySecret, publicRecords } from '../server/keystore.js';
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
import {
  availableDownloads,
  fetchAvailableOrderData,
  fetchBankParameters,
  fetchCustomerData,
} from '../server/customer-data.js';
import { changeKeys, completeKeyChange, discardKeyChange, pendingKeyChange } from '../server/key-change.js';
import {
  addSubscription,
  canonicalBtf,
  listSubscriptions,
  removeSubscription,
  setSubscriptionEnabled,
} from '../server/subscriptions.js';
import { tick } from '../server/downloads.js';
import { DomainError } from '../server/errors.js';
import { MockBank } from './mock-bank.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Asking the bank what it offers, subscribing to it, and rotating our keys.
 *
 * The three things this suite covers all exist to close the same gap: PS-12
 * used to know only what a transcribed mapping table told it, poll exactly two
 * BTFs, and be unable to change a key without a printed letter.
 */

const KEY_SECRET = loadKeySecret('22'.repeat(32));

let db: Database.Database;
let bank: MockBank;
let ctx: ExchangeContext;

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-22T09:${String(tick++).padStart(2, '0')}:00Z`;
}

async function bringUp(): Promise<void> {
  createConnection(
    db,
    {
      key: 'main',
      displayName: 'Test Bank',
      bankKey: 'at-sepa',
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
}

beforeEach(async () => {
  db = openDb(':memory:');
  bank = new MockBank();
  ctx = {
    db,
    keySecret: KEY_SECRET,
    transport: new Transport({ post: async (_url, body) => bank.post(body) }),
    actor: 'admin',
    now: fixedClock(),
  };
  await bringUp();
});

const SCHEMA_DIR = join(import.meta.dirname, 'schema');
const HAVE_SCHEMAS = existsSync(join(SCHEMA_DIR, 'ebics_orders_H005.xsd'));
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const describeIf = HAVE_SCHEMAS && HAVE_XMLLINT ? describe : describe.skip;

describeIf('the bank half emits documents a real bank could', () => {
  it.each([
    ['HTD', 'subscriber'],
    ['HKD', 'customer'],
  ] as const)('%s validates against the published schema', async (_name, scope) => {
    // Without this, every assertion below measures the parser against a
    // document written by the same reading of the specification that wrote the
    // parser — which is how four VEU field names got through once already.
    await fetchCustomerData(ctx, 'main', scope);
    const file = join(mkdtempSync(join(tmpdir(), 'ps12-htd-')), 'order-data.xml');
    writeFileSync(file, bank.served[bank.served.length - 1]!);
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, 'ebics_orders_H005.xsd'), file]);
  });

  it.each([
    ['HPD', async () => fetchBankParameters(ctx, 'main')],
    ['HAA', async () => fetchAvailableOrderData(ctx, 'main')],
  ] as const)('%s validates against the published schema', async (_name, fetch) => {
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<Document/>');
    await fetch();
    const file = join(mkdtempSync(join(tmpdir(), 'ps12-adm-')), 'order-data.xml');
    writeFileSync(file, bank.served[bank.served.length - 1]!);
    execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA_DIR, 'ebics_orders_H005.xsd'), file]);
  });
});

describe('HTD — what the bank says this subscriber may do', () => {
  it('reads the customer, the accounts and the order types', async () => {
    const data = await fetchCustomerData(ctx, 'main');
    expect(data.partner.name).toBe('0815 Software GmbH');
    expect(data.partner.hostId).toBe(bank.hostId);
    expect(data.partner.addressLines).toContain('Wien');
    expect(data.orders.map((o) => o.adminOrderType)).toContain('BTU');
    expect(data.orders.find((o) => o.adminOrderType === 'BTU')?.signaturesRequired).toBe(1);
  });

  it('reads an IBAN as an IBAN and not as a national account number', async () => {
    const data = await fetchCustomerData(ctx, 'main');
    const account = data.accounts[0]!;
    // The `international="true"` attribute is the only thing that says which
    // this is. Reading the first AccountNumber as an IBAN regardless would put
    // a national number in a field everything downstream treats as payable.
    expect(account.iban).toBe('AT611904300234573201');
    expect(account.nationalNumber).toBeNull();
    expect(account.bic).toBe('BKAUATWW');
    // Currency and Description are ATTRIBUTES on the account, not elements.
    expect(account.currency).toBe('EUR');
    expect(account.description).toBe('Girokonto');
    expect(account.holder).toBe('0815 Software GmbH');
    expect(account.id).toBe('ACC1');
  });

  it('reads the signature class and the ceiling the bank itself enforces', async () => {
    const data = await fetchCustomerData(ctx, 'main');
    const me = data.subscribers[0]!;
    expect(me.userId).toBe('USER1');
    const upload = me.permissions.find((p) => p.adminOrderType === 'BTU')!;
    expect(upload.authorisationLevel).toBe('E');
    expect(upload.maxAmount).toBe('500000.00');
    expect(upload.accountId).toBe('ACC1');
  });

  it('lists only the BTDs as available downloads, with their BTF intact', async () => {
    const data = await fetchCustomerData(ctx, 'main');
    const available = availableDownloads(data);
    // BTU is an upload and HTD carries no service at all: neither is something
    // a download subscription could fetch.
    expect(available.every((btf) => btf.service_name !== 'HTD')).toBe(true);
    expect(available).toContainEqual({
      service_name: 'EOP',
      msg_name: 'camt.053',
      scope: 'AT',
      container: 'ZIP',
    });
    expect(available).toContainEqual({ service_name: 'CIM', msg_name: 'cimresp', scope: 'AT' });
  });

  it('HKD describes every subscriber, HTD only the one asking', async () => {
    const htd = await fetchCustomerData(ctx, 'main', 'subscriber');
    const hkd = await fetchCustomerData(ctx, 'main', 'customer');
    expect(htd.subscribers).toHaveLength(1);
    expect(hkd.subscribers.length).toBeGreaterThanOrEqual(1);
  });

  it('says so plainly when the bank has not enabled the order type', async () => {
    bank.configure({ refuseCustomerData: true });
    await expect(fetchCustomerData(ctx, 'main')).rejects.toThrow(/not enabled/);
  });
});

describe('HPD — what this bank supports', () => {
  it('reads the versions, the institute and the URLs', async () => {
    const parameters = await fetchBankParameters(ctx, 'main');
    expect(parameters.access.institute).toBe('Mock Bank AG');
    expect(parameters.access.hostId).toBe(bank.hostId);
    expect(parameters.access.urls[0]!.url).toBe('https://bank.example/ebics');
    expect(parameters.access.urls[0]!.validFrom).toBe('2026-01-01T00:00:00Z');
    // Space-separated lists in the schema, so "A005 A006" is two versions.
    expect(parameters.versions.protocol).toEqual(['H005']);
    expect(parameters.versions.signature).toEqual(['A005', 'A006']);
  });

  it('reads a flag with no attribute as supported, which is the schema default', async () => {
    const parameters = await fetchBankParameters(ctx, 'main');
    // <Recovery/> with no `supported` attribute means SUPPORTED. Reading an
    // absent attribute as false would report a working feature as missing.
    expect(parameters.optionalFeatures.recovery).toBe(true);
    expect(parameters.optionalFeatures.preValidation).toBe(false);
    expect(parameters.optionalFeatures.clientDataDownload).toBe(true);
  });
});

describe('HAA — what the bank has waiting right now', () => {
  it('is empty when nothing is queued, which is the ordinary answer', async () => {
    expect(await fetchAvailableOrderData(ctx, 'main')).toEqual([]);
  });

  it('names the BTFs that actually have a file behind them', async () => {
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<Document/>');
    const waiting = await fetchAvailableOrderData(ctx, 'main');
    expect(waiting).toContainEqual({ service_name: 'EOP', msg_name: 'camt.053' });
  });
});

describe('download subscriptions — what the tick fetches', () => {
  it('starts with the profile pair, which is what the tick used to hard-code', () => {
    const subscriptions = listSubscriptions(db, 'main');
    expect(subscriptions.map((s) => s.btf.msg_name).sort()).toEqual(['camt.053', 'pain.002']);
    expect(subscriptions.every((s) => s.enabled)).toBe(true);
  });

  it('fetches a BTF nothing in this repository names, once subscribed', async () => {
    // The point of the whole change: camt.052 is in no profile, no registry
    // entry and no hard-coded pair. Subscribing is all it takes.
    addSubscription(db, 'main', {
      btf: { service_name: 'STM', scope: 'AT', msg_name: 'camt.052', container: 'ZIP' },
      label: 'intraday',
    });
    bank.enqueue({ serviceName: 'STM', msgName: 'camt.052' }, '<Document>intraday</Document>');

    const result = await tick({ ...ctx, transport: ctx.transport });
    expect(result.downloads_fetched).toBe(1);
    expect(result.problems).toEqual([]);
  });

  it('polls nothing when every subscription is off, rather than falling back', async () => {
    for (const subscription of listSubscriptions(db, 'main')) {
      setSubscriptionEnabled(db, 'main', subscription.id, false);
    }
    bank.enqueue({ serviceName: 'EOP', msgName: 'camt.053' }, '<Document/>');
    const result = await tick(ctx);
    // A silently-restored default would make an emptied list impossible to
    // empty, which is worse than fetching nothing.
    expect(result.downloads_fetched).toBe(0);
  });

  it('refuses a second subscription for the same BTF, however it is spelled', () => {
    expect(() =>
      addSubscription(db, 'main', {
        // Same BTF as the seeded statement, keys in a different order.
        btf: { container: 'ZIP', msg_name: 'camt.053', scope: 'AT', service_name: 'EOP' },
      }),
    ).toThrow(DomainError);
  });

  it('gives two spellings of one BTF the same identity', () => {
    expect(canonicalBtf({ service_name: 'EOP', scope: 'AT', msg_name: 'camt.053' })).toBe(
      canonicalBtf({ msg_name: 'camt.053', scope: 'AT', service_name: 'EOP' }),
    );
    expect(canonicalBtf({ service_name: 'EOP', msg_name: 'camt.053' })).not.toBe(
      canonicalBtf({ service_name: 'EOP', scope: 'AT', msg_name: 'camt.053' }),
    );
  });

  it('records what the last poll did, so a failing subscription is visible', async () => {
    const failing = { ...ctx, transport: new Transport({ post: async () => { throw new Error('bank is down'); } }) };
    await tick(failing);
    const subscriptions = listSubscriptions(db, 'main');
    expect(subscriptions.every((s) => s.last_problem !== null)).toBe(true);
    expect(subscriptions[0]!.last_problem).toMatch(/bank is down/);
  });

  it('removes one', () => {
    const [first] = listSubscriptions(db, 'main');
    removeSubscription(db, 'main', first!.id);
    expect(listSubscriptions(db, 'main')).toHaveLength(1);
  });
});

describe('HCA and HCS — changing our keys over the wire', () => {
  it('replaces the authentication and encryption keys, and the bank follows', async () => {
    const before = publicRecords(db, 1);
    const result = await changeKeys(ctx, 'main');
    expect(result.orderType).toBe('HCA');

    const after = publicRecords(db, 1);
    const digest = (records: typeof before, purpose: string): string =>
      records.find((r) => r.purpose === purpose)!.digest;
    expect(digest(after, 'AUTH')).not.toBe(digest(before, 'AUTH'));
    expect(digest(after, 'ENC')).not.toBe(digest(before, 'ENC'));
    // HCA leaves the key that authorises payments exactly where it was.
    expect(digest(after, 'ES')).toBe(digest(before, 'ES'));

    // And the proof that both sides moved together: the next request is signed
    // with the new authentication key, and the bank verifies it.
    await expect(fetchCustomerData(ctx, 'main')).resolves.toBeDefined();
  });

  it('HCS replaces the ES key too — the one that matters after a compromise', async () => {
    const before = publicRecords(db, 1).find((r) => r.purpose === 'ES')!.digest;
    const result = await changeKeys(ctx, 'main', { includeSignature: true });
    expect(result.orderType).toBe('HCS');
    expect(publicRecords(db, 1).find((r) => r.purpose === 'ES')!.digest).not.toBe(before);
  });

  it('leaves nothing pending after a successful change', async () => {
    await changeKeys(ctx, 'main');
    expect(pendingKeyChange(ctx, 'main')).toEqual([]);
  });

  it('keeps the old keys live and the new ones pending when the bank refuses', async () => {
    const before = publicRecords(db, 1).find((r) => r.purpose === 'AUTH')!.digest;
    bank.configure({ refuseKeyChange: true });
    await expect(changeKeys(ctx, 'main')).rejects.toThrow(/NOT changed/);

    // The connection still works, with the keys it had.
    expect(publicRecords(db, 1).find((r) => r.purpose === 'AUTH')!.digest).toBe(before);
    bank.configure({ refuseKeyChange: false });
    await expect(fetchCustomerData(ctx, 'main')).resolves.toBeDefined();

    // And the prepared keys are still on disk — not discarded on a guess,
    // because a refusal at transfer is ambiguous from this side.
    expect(pendingKeyChange(ctx, 'main')).toHaveLength(2);
  });

  it('re-sends the same prepared keys on a retry rather than asking for a third set', async () => {
    bank.configure({ refuseKeyChange: true });
    await expect(changeKeys(ctx, 'main')).rejects.toThrow();
    const first = pendingKeyChange(ctx, 'main').map((k) => k.digest);

    await expect(changeKeys(ctx, 'main')).rejects.toThrow();
    expect(pendingKeyChange(ctx, 'main').map((k) => k.digest)).toEqual(first);
  });

  it('refuses to start an HCS on top of a pending HCA', async () => {
    bank.configure({ refuseKeyChange: true });
    await expect(changeKeys(ctx, 'main')).rejects.toThrow();
    await expect(changeKeys(ctx, 'main', { includeSignature: true })).rejects.toThrow(/pending key change/);
  });

  it('discards a pending change once the bank has confirmed it did not take', async () => {
    bank.configure({ refuseKeyChange: true });
    await expect(changeKeys(ctx, 'main')).rejects.toThrow();
    discardKeyChange(ctx, 'main');
    expect(pendingKeyChange(ctx, 'main')).toEqual([]);
    // Which frees the operator to try again with a fresh set.
    bank.configure({ refuseKeyChange: false });
    await expect(changeKeys(ctx, 'main')).resolves.toBeDefined();
  });

  it('completes a change the bank accepted but this service never recorded', async () => {
    // The one gap the ordering leaves: the bank says yes and we die before
    // promoting. The pending keys are on disk, which is what makes it a
    // recovery rather than a re-initialisation.
    bank.configure({ refuseKeyChange: true });
    await expect(changeKeys(ctx, 'main')).rejects.toThrow();
    const pending = pendingKeyChange(ctx, 'main').map((k) => k.digest).sort();

    const promoted = completeKeyChange(ctx, 'main');
    expect(promoted.filter((k) => k.purpose !== 'ES').map((k) => k.digest).sort()).toEqual(pending);
    expect(pendingKeyChange(ctx, 'main')).toEqual([]);
  });

  it('refuses to complete when there is nothing pending', () => {
    expect(() => completeKeyChange(ctx, 'main')).toThrow(/no pending key change/);
  });

  it('keeps the retired keys, so which key signed what stays answerable', async () => {
    await changeKeys(ctx, 'main');
    const retired = db
      .prepare('SELECT purpose FROM subscriber_keys WHERE connection_id = 1 AND retired_at IS NOT NULL')
      .all() as { purpose: string }[];
    expect(retired.map((r) => r.purpose).sort()).toEqual(['AUTH', 'ENC']);
  });

  it('leaves the connection ready — a key change is not a lifecycle step back', async () => {
    await changeKeys(ctx, 'main');
    expect(connectionDetail(db, 'main').state).toBe('ready');
  });
});
