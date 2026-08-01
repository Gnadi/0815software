import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { dispatch, enqueueDeliveries, type FetchLike } from '../server/webhooks.js';
import {
  addressIsInternal,
  checkEgressTarget,
  egressPolicyFromEnv,
  type EgressPolicy,
  type ResolveHost,
} from '../server/egress.js';

/**
 * The service calls URLs an operator configured, from inside the customer's
 * private network. A webhook pointed at another service in the stack — or at a
 * cloud metadata endpoint — is the attack this guard exists for.
 */

const BLOCKING: EgressPolicy = { mode: 'block', allowHosts: new Set() };
const T0 = Date.parse('2026-06-01T00:00:00Z');

/** A resolver with a fixed table; anything unknown "does not resolve". */
const resolver = (table: Record<string, string[]>): ResolveHost => async (hostname) => {
  const hit = table[hostname];
  if (!hit) throw new Error('ENOTFOUND');
  return hit;
};

describe('address classification', () => {
  it('knows the internal ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata endpoint
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1', // loopback wearing an IPv6 hat
    ]) {
      expect(addressIsInternal(address), address).toBe(true);
    }
  });

  it('lets real public addresses through', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(addressIsInternal(address), address).toBe(false);
    }
  });
});

describe('target checks', () => {
  it('refuses a literal internal address without asking a resolver', async () => {
    const verdict = await checkEgressTarget('http://169.254.169.254/latest/meta-data/', BLOCKING, async () => {
      throw new Error('the resolver must not be consulted for a literal address');
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/internal address/);
  });

  it('refuses a name that resolves inward, and names the address', async () => {
    const verdict = await checkEgressTarget('http://ps01:4001/api/users', BLOCKING, resolver({ ps01: ['172.18.0.4'] }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('172.18.0.4');
  });

  it('allows a public target', async () => {
    const verdict = await checkEgressTarget('https://hooks.example.com/x', BLOCKING, resolver({ 'hooks.example.com': ['93.184.216.34'] }));
    expect(verdict.allowed).toBe(true);
  });

  it('allows an in-stack host that the operator listed', async () => {
    const policy: EgressPolicy = { mode: 'block', allowHosts: new Set(['invoicing']) };
    const verdict = await checkEgressTarget('http://invoicing:4004/api/hooks', policy, resolver({ invoicing: ['172.18.0.9'] }));
    expect(verdict.allowed).toBe(true);
  });

  it('refuses anything that is not http(s)', async () => {
    expect((await checkEgressTarget('file:///etc/passwd', BLOCKING)).allowed).toBe(false);
    expect((await checkEgressTarget('gopher://x/', BLOCKING)).allowed).toBe(false);
    expect((await checkEgressTarget('not a url', BLOCKING)).allowed).toBe(false);
  });

  it('lets an unresolvable name through — fetch will fail on its own', async () => {
    expect((await checkEgressTarget('https://nope.invalid/x', BLOCKING, resolver({}))).allowed).toBe(true);
  });

  it('checks nothing when the policy is off', async () => {
    const off: EgressPolicy = { mode: 'off', allowHosts: new Set() };
    expect((await checkEgressTarget('http://127.0.0.1/x', off)).allowed).toBe(true);
  });
});

describe('policy from the environment', () => {
  it('blocks by default and reads the allowlist', () => {
    expect(egressPolicyFromEnv({}).mode).toBe('block');
    expect(egressPolicyFromEnv({ EGRESS_MODE: 'observe' }).mode).toBe('observe');
    const policy = egressPolicyFromEnv({ EGRESS_ALLOW_HOSTS: 'invoicing, OFFERS ,ps01:4001' });
    expect([...policy.allowHosts]).toEqual(['invoicing', 'offers', 'ps01:4001']);
  });
});

describe('dispatch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO webhooks (event_type, url, secret, active, created_at) VALUES ('order.paid', 'http://ps01:4001/api/users', 's', 1, '2026-01-01T00:00:00Z')",
    ).run();
  });

  it('dead-letters a refused target instead of calling it', async () => {
    let called = 0;
    const fetchImpl: FetchLike = async () => {
      called += 1;
      return { ok: true, status: 200 };
    };
    enqueueDeliveries(db, 'order.paid', {}, T0);

    const result = await dispatch(db, fetchImpl, T0, {
      egress: BLOCKING,
      resolveHost: resolver({ ps01: ['172.18.0.4'] }),
    });

    expect(called).toBe(0);
    expect(result.dead).toBe(1);
    const row = db.prepare('SELECT status, last_error FROM webhook_deliveries').get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/egress policy/);
  });

  it('still delivers to the same host once the operator allows it', async () => {
    const posted: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      posted.push(url);
      return { ok: true, status: 200 };
    };
    enqueueDeliveries(db, 'order.paid', {}, T0);

    const result = await dispatch(db, fetchImpl, T0, {
      egress: { mode: 'block', allowHosts: new Set(['ps01']) },
      resolveHost: resolver({ ps01: ['172.18.0.4'] }),
    });

    expect(result.delivered).toBe(1);
    expect(posted).toEqual(['http://ps01:4001/api/users']);
  });
});
