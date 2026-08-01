import { describe, expect, it } from 'vitest';
import { guardedFetch, type FetchLike } from '../server/proxy.js';
import { checkEgressTarget, type EgressPolicy, type ResolveHost } from '../server/egress.js';

/**
 * PS-05 proxies calls to a base URL that lives in a connection's credentials —
 * an operator-typed value. Pointing one at another service in the stack would
 * turn "may configure a connection" into "may read the internal network", so
 * the guard wraps the HTTP client itself and covers the OAuth exchange too.
 */

const resolver = (table: Record<string, string[]>): ResolveHost => async (hostname) => {
  const hit = table[hostname];
  if (!hit) throw new Error('ENOTFOUND');
  return hit;
};

const BLOCKING: EgressPolicy = { mode: 'block', allowHosts: new Set() };

describe('guarded fetch', () => {
  it('refuses an internal target with 403 and never calls through', async () => {
    let called = 0;
    const inner: FetchLike = async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '' };
    };
    const guarded = guardedFetch(inner, BLOCKING, resolver({ ps01: ['10.0.0.5'] }));

    await expect(guarded('http://ps01:4001/api/users', { method: 'GET', headers: {} })).rejects.toMatchObject({
      status: 403,
    });
    expect(called).toBe(0);
  });

  it('passes a public target straight through', async () => {
    const seen: string[] = [];
    const inner: FetchLike = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const guarded = guardedFetch(inner, BLOCKING, resolver({ 'api.example.com': ['93.184.216.34'] }));

    const res = await guarded('https://api.example.com/v1/things', { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['https://api.example.com/v1/things']);
  });

  it('only reports in observe mode', async () => {
    const observe: EgressPolicy = { mode: 'observe', allowHosts: new Set() };
    const inner: FetchLike = async () => ({ ok: true, status: 200, text: async () => '' });
    const guarded = guardedFetch(inner, observe, resolver({ ps01: ['10.0.0.5'] }));
    await expect(guarded('http://ps01:4001/x', { method: 'GET', headers: {} })).resolves.toMatchObject({ status: 200 });
  });

  it('refuses the cloud metadata address by literal', async () => {
    expect((await checkEgressTarget('http://169.254.169.254/', BLOCKING)).allowed).toBe(false);
  });
});
