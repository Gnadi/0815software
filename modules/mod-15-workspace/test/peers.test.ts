import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createPeerClient, type FetchLike } from '../server/peers.js';
import { createModuleSessions } from '../server/sessions.js';
import type { AuthConfig } from '../server/auth.js';
import type { PeerMap } from '../server/config.js';
import { SUMMARY_VERSION, type ModuleSummary } from '../shared/summary.js';
import type { PeerSummary } from '../shared/types.js';

/**
 * Talking to the modules in the stack.
 *
 * The whole point of this file is the failure cases. A dashboard is read by
 * people during incidents, so what it does when a module is down, slow, older
 * than the contract, or lying about who it is matters more than what it does
 * when everything is fine. The rule every case checks: one sick module costs
 * one widget, never the board.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const TOKEN = 'test-machine-token';

const PEERS: PeerMap = {
  'mod-13-offers': { url: 'http://offers:3013', publicUrl: 'https://offers.example' },
  'mod-04-invoice-billing': { url: 'http://invoicing:3004', publicUrl: 'https://invoicing.example' },
  // Configured but with no browser-reachable origin: figures yes, frames no.
  'mod-10-crm-lite': { url: 'http://crm:3010', publicUrl: null },
  // A module whose users are not staff — never embeddable, however it is wired.
  'mod-07-storefront': { url: 'http://shop:3007', publicUrl: 'https://shop.example' },
};

function summaryOf(module: string, overrides: Partial<ModuleSummary> = {}): ModuleSummary {
  return {
    summary_version: SUMMARY_VERSION,
    module,
    generated_at: '2026-07-20T10:00:00.000Z',
    tiles: [{ key: 'open', label: 'Offers out', value: '3', unit: 'awaiting', tone: 'warn', href: '/offers?status=sent' }],
    lists: [
      {
        key: 'accepted_offers',
        label: 'Accepted, ready to bill',
        items: [
          { id: 'AN-2026-0007', title: 'AN-2026-0007 · Rollout', subtitle: 'Blaustern', badge: 'ACCEPTED', tone: 'good', at: '2026-07-05', href: '/offers/7' },
        ],
        href: '/offers?status=accepted',
      },
    ],
    context: { supported: ['party', 'from', 'to'], applied: [] },
    ...overrides,
  };
}

/** A fetch stub keyed by "METHOD path-suffix", so a test states only what it cares about. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown; text?: string; throws?: Error }>): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const key = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const route = routes[key] ?? routes[`${init?.method ?? 'GET'} *`];
    if (!route) return new Response('{}', { status: 404 });
    if (route.throws) throw route.throws;
    const payload = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(payload, { status: route.status ?? 200 });
  };
}

let db: Database.Database;

/**
 * `serviceToken` is an explicit key rather than a defaulted positional
 * parameter: passing `undefined` positionally would trigger the default and
 * quietly test the opposite of what the "no token" case means to test.
 */
function build(
  fetchImpl: FetchLike,
  options: { peers?: PeerMap; serviceToken?: string } = {},
): Express {
  const client = createPeerClient({
    peers: options.peers ?? PEERS,
    serviceToken: 'serviceToken' in options ? options.serviceToken : TOKEN,
    timeoutMs: 200,
    fetch: fetchImpl,
  });
  return createApp({ db, auth, peers: client, sessions: createModuleSessions(client) });
}

async function signIn(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('the catalogue', () => {
  it('reports what is installed and what can actually be framed', async () => {
    const app = build(stubFetch({}));
    const cookie = await signIn(app);
    const res = await request(app).get('/api/catalogue').set('Cookie', cookie).expect(200);

    const byId = new Map<string, { configured: boolean; embeddable: boolean }>(
      res.body.modules.map((m: { id: string; configured: boolean; embeddable: boolean }) => [m.id, m]),
    );
    expect(res.body.modules).toHaveLength(14);
    expect(byId.get('mod-13-offers')).toMatchObject({ configured: true, embeddable: true });
    // Not in this stack.
    expect(byId.get('mod-11-time-tracking')).toMatchObject({ configured: false, embeddable: false });
    // Wired, but with no public origin — the board must not offer a frame it
    // cannot fill.
    expect(byId.get('mod-10-crm-lite')).toMatchObject({ configured: true, embeddable: false });
    // Its users are shop guests; the Workspace has no principal to assert.
    expect(byId.get('mod-07-storefront')).toMatchObject({ configured: true, embeddable: false });
  });

  it('offers an action only when both of its ends are in the stack', async () => {
    const both = build(stubFetch({}));
    let cookie = await signIn(both);
    let res = await request(both).get('/api/catalogue').set('Cookie', cookie).expect(200);
    expect(res.body.actions.find((a: { id: string }) => a.id === 'bill-offer').available).toBe(true);

    const offersOnly = build(stubFetch({}), { peers: { 'mod-13-offers': PEERS['mod-13-offers']! } });
    cookie = await signIn(offersOnly);
    res = await request(offersOnly).get('/api/catalogue').set('Cookie', cookie).expect(200);
    // A BILL THIS button in a stack with no invoicing module is a button whose
    // only possible outcome is an error.
    expect(res.body.actions.find((a: { id: string }) => a.id === 'bill-offer').available).toBe(false);
  });
});

describe('the peer map', () => {
  it('does not mistake an inherited property for an installed module', async () => {
    // `peers[id]` answers truthily for `__proto__`, `constructor` and
    // `toString` on a stack that contains none of them. Module ids arrive from
    // a URL, so a lookup that can hand back a function where a config was
    // expected is a trap worth closing before some later caller checks things
    // in a different order.
    const app = build(stubFetch({ 'POST *': { body: { redeem_path: '/session/handoff?ticket=abc' } } }));
    const cookie = await signIn(app);
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const res = await request(app).get(`/api/embed/${encodeURIComponent(id)}`).set('Cookie', cookie);
      expect(res.status, `${id} was treated as a module`).toBe(409);
    }
  });
});

describe('collecting summaries', () => {
  it('asks every configured peer, with the machine token', async () => {
    const seen: { url: string; token?: string }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), token: headers.get('X-Service-Token') ?? undefined });
      const module = new URL(input).host.replace(/:.*/, '');
      const id = Object.keys(PEERS).find((k) => PEERS[k]!.url.includes(module))!;
      return new Response(JSON.stringify(summaryOf(id)), { status: 200 });
    };

    const app = build(fetchImpl);
    const cookie = await signIn(app);
    const res = await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);

    expect(res.body.summaries).toHaveLength(4);
    expect(seen).toHaveLength(4);
    // The browser never holds this. That is what lets peers treat it as a
    // machine credential at all.
    expect(seen.every((call) => call.token === TOKEN)).toBe(true);
  });

  it('passes the person’s context on to every peer', async () => {
    const urls: string[] = [];
    const app = build(async (input) => {
      urls.push(String(input));
      const id = Object.keys(PEERS).find((k) => String(input).startsWith(PEERS[k]!.url))!;
      return new Response(JSON.stringify(summaryOf(id)), { status: 200 });
    });
    const cookie = await signIn(app);

    await request(app).put('/api/context').set('Cookie', cookie).send({ party: 77, from: '2026-01-01' }).expect(200);
    urls.length = 0;
    await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);

    expect(urls.every((u) => u.includes('party=77') && u.includes('from=2026-01-01'))).toBe(true);
  });

  it('turns one sick peer into one failed widget, not a failed board', async () => {
    const app = build(async (input) => {
      if (String(input).startsWith('http://offers')) throw new Error('connect ECONNREFUSED');
      const id = Object.keys(PEERS).find((k) => String(input).startsWith(PEERS[k]!.url))!;
      return new Response(JSON.stringify(summaryOf(id)), { status: 200 });
    });
    const cookie = await signIn(app);

    const res = await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);
    const byId = new Map<string, PeerSummary>(res.body.summaries.map((s: PeerSummary) => [s.module, s]));

    expect(byId.get('mod-13-offers')).toMatchObject({ ok: false, problem: expect.stringContaining('ECONNREFUSED') });
    expect(byId.get('mod-04-invoice-billing')!.ok).toBe(true);
  });

  /**
   * Each of these needs a DIFFERENT fix, so each gets its own words. Collapsing
   * them into "unavailable" is what makes a dashboard useless for diagnosis —
   * which is precisely when someone opens one.
   */
  it('names the reason in terms of what an operator would have to change', async () => {
    const cases: [string, { status?: number; body?: unknown; text?: string; throws?: Error }, RegExp][] = [
      ['refused the token', { status: 401 }, /service token/i],
      ['older than the contract', { status: 404 }, /upgrade the module/i],
      ['answered something else', { status: 502 }, /answered 502/],
      ['not JSON at all', { status: 200, text: '<html>gateway</html>' }, /non-JSON/],
      ['broke the contract', { status: 200, body: { summary_version: SUMMARY_VERSION, module: 'mod-13-offers' } }, /contract/],
      ['claimed a different identity', { status: 200, body: summaryOf('mod-99-imposter') }, /identified itself/],
    ];

    for (const [, route, expected] of cases) {
      const app = build(stubFetch({ 'GET *': route }), { peers: { 'mod-13-offers': PEERS['mod-13-offers']! } });
      const cookie = await signIn(app);
      const res = await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);
      expect(res.body.summaries[0].ok).toBe(false);
      expect(res.body.summaries[0].problem).toMatch(expected);
    }
  });

  it('gives up on a peer that never answers, and says so', async () => {
    const app = build(
      () => new Promise<Response>(() => {
        /* never resolves — a hung module, not a refused connection */
      }),
      { peers: { 'mod-13-offers': PEERS['mod-13-offers']! } },
    );
    const cookie = await signIn(app);
    const res = await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);
    expect(res.body.summaries[0]).toMatchObject({ ok: false, problem: 'timed out' });
  });

  it('stops reading a peer that answers enormously, instead of buying the whole body', async () => {
    // The deadline bounds a SLOW peer; it does nothing about a fast, huge one.
    // A mistyped URL pointing at a file server is the realistic version. The
    // stream is cut at the cap, so the bytes already sent are the only ones
    // this process ever holds.
    let pushed = 0;
    const app = build(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pushed += 1;
              // 64 KiB a go: the cap is 1 MiB, so a reader that never stops
              // would run forever here.
              controller.enqueue(new Uint8Array(64 * 1024));
            },
          }),
          { status: 200 },
        ),
      { peers: { 'mod-13-offers': PEERS['mod-13-offers']! } },
    );
    const cookie = await signIn(app);
    const res = await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);

    expect(res.body.summaries[0]).toMatchObject({ ok: false, problem: expect.stringContaining('KiB') });
    // Bounded, and by a small multiple of the cap rather than by the timeout.
    expect(pushed).toBeLessThan(64);
  });

  it('says plainly when the stack has no machine token at all', async () => {
    const app = build(stubFetch({}), { serviceToken: undefined });
    const cookie = await signIn(app);
    const res = await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);
    expect(res.body.summaries[0].problem).toMatch(/PLATFORM_SERVICE_TOKEN/);
  });
});

describe('opening a module inside the Workspace', () => {
  it('returns a public URL that redeems a handoff ticket', async () => {
    const app = build(
      stubFetch({
        'POST offers:3013/api/session/handoff': { body: { redeem_path: '/session/handoff?ticket=abc', expires_at: '2026-07-20T10:00:30Z' } },
      }),
    );
    const cookie = await signIn(app);

    const res = await request(app)
      .get('/api/embed/mod-13-offers?path=%2Foffers%3Fstatus%3Dsent')
      .set('Cookie', cookie)
      .expect(200);

    // Joined onto the PUBLIC origin: the browser follows this, and it cannot
    // reach a container name.
    expect(res.body.url).toBe('https://offers.example/session/handoff?ticket=abc');
  });

  it('asks for the ticket on behalf of whoever is signed in', async () => {
    const bodies: unknown[] = [];
    const app = build(async (input, init) => {
      if (String(input).includes('/api/session/handoff')) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ redeem_path: '/session/handoff?ticket=abc' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const cookie = await signIn(app);
    await request(app).get('/api/embed/mod-13-offers').set('Cookie', cookie).expect(200);
    expect(bodies).toEqual([{ actor: 'admin', path: '/' }]);
  });

  it('refuses to frame a module that is not embeddable, or has no public URL', async () => {
    const app = build(stubFetch({ 'POST *': { body: { redeem_path: '/session/handoff?ticket=abc' } } }));
    const cookie = await signIn(app);

    const shop = await request(app).get('/api/embed/mod-07-storefront').set('Cookie', cookie).expect(409);
    expect(shop.body.error).toMatch(/cannot be embedded/);

    const crm = await request(app).get('/api/embed/mod-10-crm-lite').set('Cookie', cookie).expect(409);
    expect(crm.body.error).toMatch(/public URL/);

    await request(app).get('/api/embed/mod-11-time-tracking').set('Cookie', cookie).expect(409);
  });

  it('refuses a destination outside the target module', async () => {
    const app = build(stubFetch({ 'POST *': { body: { redeem_path: '/session/handoff?ticket=abc' } } }));
    const cookie = await signIn(app);

    // This is the point where a path becomes a URL the browser follows, so it
    // is checked here as well as in the summary contract that produced it.
    for (const path of ['https://evil.example', '//evil.example', 'offers']) {
      await request(app).get(`/api/embed/mod-13-offers?path=${encodeURIComponent(path)}`).set('Cookie', cookie).expect(422);
    }
  });
});

describe('running a cross-module action', () => {
  /** A stack where MOD-04 issues sessions and accepts the import. */
  function billingStack(onImport: (headers: Headers, body: unknown) => Response) {
    return build(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/issue')) {
        return new Response(JSON.stringify({ cookie_name: 'mod04_session', token: 'tok-for-admin' }), { status: 200 });
      }
      if (url.endsWith('/api/invoices/import-offer')) {
        return onImport(new Headers(init?.headers), JSON.parse(String(init?.body)));
      }
      return new Response('{}', { status: 404 });
    });
  }

  it('calls the target’s own route, as the person, with no new endpoint anywhere', async () => {
    const calls: { cookie: string | null; body: unknown }[] = [];
    const app = billingStack((headers, body) => {
      calls.push({ cookie: headers.get('Cookie'), body });
      return new Response(JSON.stringify({ id: 4, number: 'RE-2026-0004', imported: true }), { status: 201 });
    });
    const cookie = await signIn(app);

    const res = await request(app)
      .post('/api/actions/bill-offer')
      .set('Cookie', cookie)
      .send({ item_id: 'AN-2026-0007' })
      .expect(200);

    expect(res.body.message).toBe('Billed AN-2026-0007 — draft invoice created');
    // The session it obtained for this person is what authorizes the write.
    // The machine token performs no writes anywhere in this design.
    expect(calls).toEqual([{ cookie: 'mod04_session=tok-for-admin', body: { offer_number: 'AN-2026-0007' } }]);
  });

  it('reuses one module session across repeated actions', async () => {
    let issued = 0;
    const app = build(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/session/issue')) {
        issued += 1;
        return new Response(JSON.stringify({ cookie_name: 'mod04_session', token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    });
    const cookie = await signIn(app);

    for (const number of ['AN-1', 'AN-2', 'AN-3']) {
      await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: number }).expect(200);
    }
    expect(issued).toBe(1);
  });

  it('passes the target’s own refusal through, rather than inventing one', async () => {
    const app = billingStack(() => new Response(JSON.stringify({ error: 'Offer AN-2026-0007 is sent, not accepted' }), { status: 409 }));
    const cookie = await signIn(app);

    const res = await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: 'AN-2026-0007' }).expect(409);
    // "The action failed" would send someone to the wrong module to look.
    expect(res.body.error).toBe('Offer AN-2026-0007 is sent, not accepted');
  });

  it('refuses when the target is not in the stack, or the module will not issue a session', async () => {
    const noTarget = build(stubFetch({}), { peers: { 'mod-13-offers': PEERS['mod-13-offers']! } });
    let cookie = await signIn(noTarget);
    await request(noTarget).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: 'AN-1' }).expect(409);

    const refuses = build(stubFetch({ 'POST *': { status: 401 } }));
    cookie = await signIn(refuses);
    const res = await request(refuses).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: 'AN-1' }).expect(409);
    expect(res.body.error).toMatch(/not configured to accept this shell/);
  });

  it('refuses an unknown action or a missing item', async () => {
    const app = billingStack(() => new Response('{}', { status: 201 }));
    const cookie = await signIn(app);
    await request(app).post('/api/actions/nope').set('Cookie', cookie).send({ item_id: 'AN-1' }).expect(404);
    await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({}).expect(422);
    await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: '  ' }).expect(422);
  });

  it('refuses an item reference too long to be one', async () => {
    // Forwarded verbatim into a request to another module. An item id is a
    // reference the peer itself put in a summary — an offer number, a ticket
    // key — so length is a reliable sign it is not one.
    const app = billingStack(() => new Response('{}', { status: 201 }));
    const cookie = await signIn(app);
    await request(app)
      .post('/api/actions/bill-offer')
      .set('Cookie', cookie)
      .send({ item_id: 'A'.repeat(201) })
      .expect(422);
  });

  it('requires a session of its own — the board is not a public API', async () => {
    const app = billingStack(() => new Response('{}', { status: 201 }));
    await request(app).post('/api/actions/bill-offer').send({ item_id: 'AN-1' }).expect(401);
  });
});

describe('readiness', () => {
  it('stays ready while every peer is down', async () => {
    const app = build(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    // A Workspace whose peers are down has unavailable widgets, not an
    // unhealthy service — reporting otherwise would pull the dashboard out of
    // the load balancer during exactly the incident someone opens it to read.
    await request(app).get('/api/ready').expect(200);
  });
});

describe('the module-session vault', () => {
  it('forgets a person’s module sessions when they log out', async () => {
    let issued = 0;
    const app = build(async (input) => {
      if (String(input).endsWith('/api/session/issue')) {
        issued += 1;
        return new Response(JSON.stringify({ cookie_name: 'mod04_session', token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    });

    let cookie = await signIn(app);
    await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: 'AN-1' }).expect(200);
    await request(app).post('/api/logout').set('Cookie', cookie).expect(200);

    cookie = await signIn(app);
    await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: 'AN-2' }).expect(200);
    // They were obtained so the board could act as that person, and the board
    // is no longer theirs to act on.
    expect(issued).toBe(2);
  });
});

describe('the activity feed', () => {
  it('is empty and honest when PS-07 is not configured', async () => {
    const app = build(stubFetch({}));
    const cookie = await signIn(app);
    const res = await request(app).get('/api/activity').set('Cookie', cookie).expect(200);
    expect(res.body.events).toEqual([]);
  });
});

describe('peer timeouts are bounded', () => {
  it('does not let a slow peer hold the board past its timeout', async () => {
    const started = Date.now();
    const app = build(
      () => new Promise<Response>(() => undefined),
      { peers: { 'mod-13-offers': PEERS['mod-13-offers']!, 'mod-04-invoice-billing': PEERS['mod-04-invoice-billing']! } },
    );
    const cookie = await signIn(app);
    await request(app).get('/api/summaries').set('Cookie', cookie).expect(200);
    // Two hung peers, fetched concurrently: the board waits one timeout, not
    // two. This is why `summaries` fans out rather than looping.
    expect(Date.now() - started).toBeLessThan(600);
  });
});
