import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createPeerClient, type FetchLike } from '../server/peers.js';
import { createModuleSessions } from '../server/sessions.js';
import { buildPlatform } from '../server/platform.js';
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

  /**
   * The sales chain the catalogue actually has:
   *
   *     MOD-10 deal ──QUOTE──▶ MOD-13 offer ──BILL──▶ MOD-04 invoice
   *                                  │
   *                                  └────PLAN────▶ MOD-11 project
   *
   * Availability is per link, not per chain. This stack has CRM, Offers and
   * Invoicing but no Time Tracking, so two of the three are live — which is
   * the ordinary case, since customers license modules one at a time.
   */
  it('offers each link of the chain independently of the others', async () => {
    const app = build(stubFetch({}));
    const cookie = await signIn(app);
    const res = await request(app).get('/api/catalogue').set('Cookie', cookie).expect(200);

    const byId = new Map<string, { available: boolean; source_module: string; target_module: string }>(
      res.body.actions.map((a: { id: string }) => [a.id, a]),
    );
    expect([...byId.keys()].sort()).toEqual(['bill-offer', 'plan-offer', 'quote-deal']);
    expect(byId.get('quote-deal')).toMatchObject({
      available: true,
      source_module: 'mod-10-crm-lite',
      target_module: 'mod-13-offers',
    });
    // MOD-11 is not in this stack, so PLAN WORK has nowhere to go.
    expect(byId.get('plan-offer')).toMatchObject({
      available: false,
      source_module: 'mod-13-offers',
      target_module: 'mod-11-time-tracking',
    });
  });

  it('attaches both offer actions to the same list, without either shadowing the other', async () => {
    const withTime = build(stubFetch({}), {
      peers: { ...PEERS, 'mod-11-time-tracking': { url: 'http://time:3011', publicUrl: 'https://time.example' } },
    });
    const cookie = await signIn(withTime);
    const res = await request(withTime).get('/api/catalogue').set('Cookie', cookie).expect(200);

    // An accepted offer is usually two things at once — something to invoice
    // and something to do — so both buttons sit on the same row. Neither is a
    // step towards the other, and the UI renders one button per action.
    const onAccepted = res.body.actions.filter(
      (a: { source_module: string; source_list: string; available: boolean }) =>
        a.source_module === 'mod-13-offers' && a.source_list === 'accepted_offers' && a.available,
    );
    expect(onAccepted.map((a: { id: string }) => a.id).sort()).toEqual(['bill-offer', 'plan-offer']);
  });

  /**
   * Without PS-01 every operator authenticates as the one configured admin, so
   * they share an actor — and therefore share boards, the customer filter, and
   * the name that lands in a target module's history when an action runs. That
   * is not a fault, but it is a surprise, so the board says it out loud. The
   * flag has to come from configuration rather than from the UI guessing,
   * because a stack CAN be wired with PS-01 and still show one person.
   */
  it('says whether logins are validated by an identity provider', async () => {
    const standalone = build(stubFetch({}));
    let cookie = await signIn(standalone);
    let res = await request(standalone).get('/api/catalogue').set('Cookie', cookie).expect(200);
    expect(res.body.identity_configured).toBe(false);

    const client = createPeerClient({ peers: PEERS, serviceToken: TOKEN, timeoutMs: 200, fetch: stubFetch({}) });
    const withIdentity = createApp({
      db,
      auth,
      peers: client,
      sessions: createModuleSessions(client),
      identityConfigured: true,
    });
    cookie = await signIn(withIdentity);
    res = await request(withIdentity).get('/api/catalogue').set('Cookie', cookie).expect(200);
    expect(res.body.identity_configured).toBe(true);
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

describe('several boards asking at once', () => {
  it('collapses simultaneous fan-outs for the same context into one', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = createPeerClient({
      peers: { 'mod-13-offers': PEERS['mod-13-offers']! },
      serviceToken: TOKEN,
      timeoutMs: 5_000,
      fetch: async () => {
        calls += 1;
        await gate;
        return new Response(JSON.stringify(summaryOf('mod-13-offers')), { status: 200 });
      },
    });

    // Ten boards refreshing on the same tick, all looking at everything.
    const rounds = Array.from({ length: 10 }, () => client.summaries({}));
    release!();
    const answers = await Promise.all(rounds);

    expect(calls, 'one round of requests, not ten').toBe(1);
    for (const answer of answers) expect(answer[0]!.ok).toBe(true);
  });

  it('does not hand one person’s customer view to another', async () => {
    const asked: string[] = [];
    const client = createPeerClient({
      peers: { 'mod-13-offers': PEERS['mod-13-offers']! },
      serviceToken: TOKEN,
      timeoutMs: 5_000,
      fetch: async (input) => {
        asked.push(new URL(input).search);
        return new Response(JSON.stringify(summaryOf('mod-13-offers')), { status: 200 });
      },
    });

    // Different contexts are different questions. Sharing an answer between
    // them would show one person another customer's figures.
    await Promise.all([client.summaries({ party: 1 }), client.summaries({ party: 2 }), client.summaries({})]);
    expect(new Set(asked).size).toBe(3);
  });

  it('does not let a failed round poison every later one', async () => {
    let attempt = 0;
    const client = createPeerClient({
      peers: { 'mod-13-offers': PEERS['mod-13-offers']! },
      serviceToken: TOKEN,
      timeoutMs: 5_000,
      fetch: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('connect ECONNREFUSED');
        return new Response(JSON.stringify(summaryOf('mod-13-offers')), { status: 200 });
      },
    });

    // An in-flight entry left behind after a rejection would serve that failure
    // to every later caller for the life of the process — the one way
    // deduplication is worse than repetition.
    const first = await client.summaries({});
    expect(first[0]!.ok).toBe(false);
    const second = await client.summaries({});
    expect(second[0]!.ok).toBe(true);
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

  /**
   * The two links added alongside billing. They exercise the SAME runner —
   * `/api/actions/:id` reads the descriptor and knows nothing about offers,
   * deals or projects — so what these cases actually pin down is that each
   * descriptor names the target, the path and the body field its target really
   * expects. A typo in any of the three is a button that 404s in production and
   * nowhere else, which is precisely the failure a declarative catalogue is
   * supposed to make impossible to ship.
   */
  function chainStack(
    calls: { url: string; cookie: string | null; body: unknown }[],
    peerMap: PeerMap,
  ): Express {
    return build(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/session/issue') {
          return new Response(JSON.stringify({ cookie_name: 'sess', token: `tok-${url.host}` }), { status: 200 });
        }
        calls.push({
          url: `${url.host}${url.pathname}`,
          cookie: new Headers(init?.headers).get('Cookie'),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ id: 9, imported: true }), { status: 201 });
      },
      { peers: peerMap },
    );
  }

  it('quotes a deal by calling MOD-13’s own import route', async () => {
    const calls: { url: string; cookie: string | null; body: unknown }[] = [];
    const app = chainStack(calls, PEERS);
    const cookie = await signIn(app);

    const res = await request(app)
      .post('/api/actions/quote-deal')
      .set('Cookie', cookie)
      .send({ item_id: '3' })
      .expect(200);

    expect(res.body.message).toBe('Quoted deal 3 — draft offer created');
    // The item id of a deal in MOD-10's summary is its primary key, and
    // `deal_id` is the field MOD-13's route reads.
    expect(calls).toEqual([
      { url: 'offers:3013/api/offers/import-deal', cookie: 'sess=tok-offers:3013', body: { deal_id: '3' } },
    ]);
  });

  it('plans an offer by calling MOD-11’s own import route', async () => {
    const calls: { url: string; cookie: string | null; body: unknown }[] = [];
    const app = chainStack(calls, {
      ...PEERS,
      'mod-11-time-tracking': { url: 'http://time:3011', publicUrl: 'https://time.example' },
    });
    const cookie = await signIn(app);

    const res = await request(app)
      .post('/api/actions/plan-offer')
      .set('Cookie', cookie)
      .send({ item_id: 'AN-2026-0007' })
      .expect(200);

    expect(res.body.message).toBe('Planned AN-2026-0007 — project created for time tracking');
    expect(calls).toEqual([
      {
        url: 'time:3011/api/projects/import-offer',
        cookie: 'sess=tok-time:3011',
        body: { offer_number: 'AN-2026-0007' },
      },
    ]);
  });

  it('holds a separate session per module, so one action never acts inside another', async () => {
    const calls: { url: string; cookie: string | null; body: unknown }[] = [];
    const app = chainStack(calls, {
      ...PEERS,
      'mod-11-time-tracking': { url: 'http://time:3011', publicUrl: 'https://time.example' },
    });
    const cookie = await signIn(app);

    await request(app).post('/api/actions/bill-offer').set('Cookie', cookie).send({ item_id: 'AN-1' }).expect(200);
    await request(app).post('/api/actions/plan-offer').set('Cookie', cookie).send({ item_id: 'AN-1' }).expect(200);

    // A module's session is minted by that module and bound to it — a MOD-04
    // cookie is not a credential anywhere else, and the vault must not treat
    // one person's sessions as interchangeable just because the actor matches.
    expect(calls.map((c) => c.cookie)).toEqual(['sess=tok-invoicing:3004', 'sess=tok-time:3011']);
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

describe('the credentials the board holds for a person', () => {
  it('drops the PS-01 token on logout, not only the module sessions', async () => {
    const client = createPeerClient({ peers: PEERS, serviceToken: TOKEN, timeoutMs: 200, fetch: stubFetch({}) });
    const sessions = createModuleSessions(client);
    sessions.rememberIdentity('ada@example', 'ps01-token');
    expect(sessions.identityFor('ada@example')).toBe('ps01-token');

    sessions.forget('ada@example');
    // The interface promises this is dropped on logout; for a while it was not,
    // and the token outlived the session that produced it.
    expect(sessions.identityFor('ada@example')).toBeUndefined();
  });

  it('lets a held token expire rather than keeping it for the life of the process', () => {
    let clock = 1_000_000;
    const client = createPeerClient({ peers: PEERS, serviceToken: TOKEN, timeoutMs: 200, fetch: stubFetch({}) });
    const sessions = createModuleSessions(client, () => clock);
    sessions.rememberIdentity('ada@example', 'ps01-token');

    clock += 14 * 60_000;
    expect(sessions.identityFor('ada@example')).toBe('ps01-token');

    clock += 2 * 60_000; // past the 15-minute hold
    expect(sessions.identityFor('ada@example')).toBeUndefined();
  });

  it('forgets one person without forgetting another whose name is a prefix', async () => {
    const issued: string[] = [];
    const client = createPeerClient({
      peers: PEERS,
      serviceToken: TOKEN,
      timeoutMs: 200,
      fetch: async (input, init) => {
        if (String(input).endsWith('/api/session/issue')) {
          issued.push(JSON.parse(String(init?.body)).actor);
          return new Response(JSON.stringify({ cookie_name: 'mod04_session', token: 'tok' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });
    const sessions = createModuleSessions(client);

    await sessions.cookieFor('ada', 'mod-04-invoice-billing');
    await sessions.cookieFor('ada smith', 'mod-04-invoice-billing');
    expect(sessions.size()).toBe(2);

    // Keys join on NUL for exactly this reason: on a space, "ada" would be a
    // prefix of "ada smith" and this would drop both.
    sessions.forget('ada');
    expect(sessions.size()).toBe(1);
  });
});

describe('the activity feed', () => {
  /**
   * "Nothing has happened yet" and "this stack has no audit service" are
   * different facts with different fixes, and they produce the same empty
   * array. The `configured` flag is the only thing that tells them apart, so
   * it has to name the right service — it once reported PS-11 Customers by
   * copy-paste, which made an unwired audit log look merely quiet.
   */
  it('says the audit service is absent, not that nothing has happened', async () => {
    const app = build(stubFetch({}));
    const cookie = await signIn(app);
    const res = await request(app).get('/api/activity').set('Cookie', cookie).expect(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.configured).toBe(false);
  });

  it('reports PS-07, not whichever other service happens to be wired', async () => {
    // PS-11 present, PS-07 absent: the feed must still say it is unconfigured.
    const client = createPeerClient({ peers: PEERS, serviceToken: TOKEN, timeoutMs: 200, fetch: stubFetch({}) });
    const withCustomersOnly = createApp({
      db,
      auth,
      peers: client,
      sessions: createModuleSessions(client),
      platform: buildPlatform({ customersUrl: 'http://customers:4011', serviceToken: TOKEN }),
    });
    const cookie = await signIn(withCustomersOnly);

    const activity = await request(withCustomersOnly).get('/api/activity').set('Cookie', cookie).expect(200);
    expect(activity.body.configured).toBe(false);

    // …while the picker, which really is PS-11's, says it IS configured.
    const catalogue = await request(withCustomersOnly).get('/api/catalogue').set('Cookie', cookie).expect(200);
    expect(catalogue.body.customers_configured).toBe(true);
  });

  it('reports it as configured once PS-07 is wired', async () => {
    const client = createPeerClient({ peers: PEERS, serviceToken: TOKEN, timeoutMs: 200, fetch: stubFetch({}) });
    const withAudit = createApp({
      db,
      auth,
      peers: client,
      sessions: createModuleSessions(client),
      platform: buildPlatform({ auditUrl: 'http://audit:4007', serviceToken: TOKEN }),
    });
    const cookie = await signIn(withAudit);
    const res = await request(withAudit).get('/api/activity').set('Cookie', cookie).expect(200);
    expect(res.body.configured).toBe(true);
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
