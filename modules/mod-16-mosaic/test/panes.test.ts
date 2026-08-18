import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createPeerClient, type FetchLike } from '../server/peers.js';
import type { AuthConfig } from '../server/auth.js';
import type { PeerMap } from '../server/config.js';

/**
 * Boards of panes, and what may go on one.
 *
 * The rule that carries the weight: a pane may only name a module that this
 * shell can actually frame. Three modules in the catalogue authenticate their
 * OWN end users — portal customers, shop guests, matter users — so a staff
 * shell has no identity to hand them, and a frame would show a login form
 * nobody here can fill. The picker hides them; these cases prove the API
 * refuses them too, because a stale client or a curl is not a threat model but
 * it is a support ticket.
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
  // Wired, but with no browser-reachable origin: a frame cannot be filled.
  'mod-10-crm-lite': { url: 'http://crm:3010', publicUrl: null },
  // Wired and reachable, but it authenticates shop guests.
  'mod-07-storefront': { url: 'http://shop:3007', publicUrl: 'https://shop.example' },
  // A shell inside a shell: allowed, and the reason MOD-15 is in the catalogue.
  'mod-15-workspace': { url: 'http://workspace:3015', publicUrl: 'https://workspace.example' },
};

function stub(routes: Record<string, { status?: number; body?: unknown }> = {}): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const route = routes[`${init?.method ?? 'GET'} ${url.host}${url.pathname}`];
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  };
}

let db: Database.Database;

function build(fetchImpl: FetchLike = stub(), peers: PeerMap = PEERS): Express {
  return createApp({
    db,
    auth,
    peers: createPeerClient({ peers, serviceToken: TOKEN, timeoutMs: 200, fetch: fetchImpl }),
  });
}

async function signIn(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function firstBoard(app: Express, cookie: string): Promise<number> {
  const res = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
  return res.body.boards[0].id as number;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('the catalogue', () => {
  it('says which modules can actually be tiled, and why the rest cannot', async () => {
    const app = build();
    const cookie = await signIn(app);
    const res = await request(app).get('/api/catalogue').set('Cookie', cookie).expect(200);

    const byId = new Map<string, { configured: boolean; embeddable: boolean }>(
      res.body.modules.map((m: { id: string }) => [m.id, m]),
    );
    // Fifteen: the fourteen business modules plus the Workspace, which this
    // shell can frame like any other. This module is absent — framing itself
    // is a recursion with no bottom.
    expect(res.body.modules).toHaveLength(15);
    expect(byId.get('mod-16-mosaic')).toBeUndefined();

    expect(byId.get('mod-13-offers')).toMatchObject({ configured: true, embeddable: true });
    expect(byId.get('mod-15-workspace')).toMatchObject({ configured: true, embeddable: true });
    // Wired, but a browser cannot reach a container name.
    expect(byId.get('mod-10-crm-lite')).toMatchObject({ configured: true, embeddable: false });
    // Reachable, but its users are shop guests.
    expect(byId.get('mod-07-storefront')).toMatchObject({ configured: true, embeddable: false });
    // Not licensed here at all.
    expect(byId.get('mod-11-time-tracking')).toMatchObject({ configured: false, embeddable: false });
  });
});

describe('panes', () => {
  it('starts a person on an empty board rather than an invented one', async () => {
    const app = build();
    const cookie = await signIn(app);
    const res = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);

    expect(res.body.boards).toHaveLength(1);
    // Deliberately empty: which modules a customer licensed is not knowable
    // from here, and a pane naming one that is absent would greet everybody
    // with a broken frame.
    expect(res.body.boards[0].panes).toEqual([]);
  });

  it('adds a module as a pane', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);

    const res = await request(app)
      .post(`/api/boards/${board}/panes`)
      .set('Cookie', cookie)
      .send({ module_id: 'mod-13-offers' })
      .expect(201);
    expect(res.body).toMatchObject({ module_id: 'mod-13-offers', board_id: board });
    // A pane is big by default: it holds a whole application, not one figure.
    expect(res.body.w).toBeGreaterThanOrEqual(3);
    expect(res.body.h).toBeGreaterThanOrEqual(3);
  });

  it('allows the same module twice, because two views side by side is the point', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);

    await request(app).post(`/api/boards/${board}/panes`).set('Cookie', cookie).send({ module_id: 'mod-13-offers', x: 0 }).expect(201);
    await request(app).post(`/api/boards/${board}/panes`).set('Cookie', cookie).send({ module_id: 'mod-13-offers', x: 6 }).expect(201);

    const res = await request(app).get(`/api/boards/${board}`).set('Cookie', cookie).expect(200);
    expect(res.body.panes).toHaveLength(2);
  });

  it('refuses a module that authenticates its own end users', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);

    const res = await request(app)
      .post(`/api/boards/${board}/panes`)
      .set('Cookie', cookie)
      .send({ module_id: 'mod-07-storefront' })
      .expect(422);
    // The reason, not just a refusal: "cannot be framed" sends someone to check
    // their URLs, which is the wrong place entirely.
    expect(JSON.stringify(res.body)).toMatch(/end users/);
  });

  it('refuses a module that is not in the catalogue at all', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);

    for (const bogus of ['mod-99-nonsense', '__proto__', 'constructor', '']) {
      await request(app)
        .post(`/api/boards/${board}/panes`)
        .set('Cookie', cookie)
        .send({ module_id: bogus })
        .expect(422);
    }
  });

  it('refuses a pane wider than the grid', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);

    await request(app)
      .post(`/api/boards/${board}/panes`)
      .set('Cookie', cookie)
      .send({ module_id: 'mod-13-offers', x: 9, w: 6 })
      .expect(422);
  });

  it('saves an arrangement in one go, and refuses a pane from another board', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);
    const pane = (
      await request(app).post(`/api/boards/${board}/panes`).set('Cookie', cookie).send({ module_id: 'mod-13-offers' })
    ).body;

    const moved = await request(app)
      .put(`/api/boards/${board}/layout`)
      .set('Cookie', cookie)
      .send({ panes: [{ id: pane.id, x: 3, y: 2, w: 6, h: 5 }] })
      .expect(200);
    expect(moved.body.panes[0]).toMatchObject({ x: 3, y: 2, w: 6, h: 5 });

    await request(app)
      .put(`/api/boards/${board}/layout`)
      .set('Cookie', cookie)
      .send({ panes: [{ id: pane.id + 999, x: 0, y: 0, w: 6, h: 6 }] })
      .expect(404);
  });

  it('removes a pane', async () => {
    const app = build();
    const cookie = await signIn(app);
    const board = await firstBoard(app, cookie);
    const pane = (
      await request(app).post(`/api/boards/${board}/panes`).set('Cookie', cookie).send({ module_id: 'mod-13-offers' })
    ).body;

    await request(app).delete(`/api/boards/${board}/panes/${pane.id}`).set('Cookie', cookie).expect(200);
    await request(app).delete(`/api/boards/${board}/panes/${pane.id}`).set('Cookie', cookie).expect(404);
  });
});

describe('opening a pane', () => {
  it('asks the module for a single-use ticket and returns its PUBLIC url', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const app = build(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ redeem_path: '/session/handoff?ticket=abc' }), { status: 200 });
    });
    const cookie = await signIn(app);

    const res = await request(app).get('/api/embed/mod-13-offers').set('Cookie', cookie).expect(200);
    // The browser follows this, so it must be the public origin — a container
    // name would simply not resolve.
    expect(res.body.url).toBe('https://offers.example/session/handoff?ticket=abc');
    // …while the shell's own call went to the internal one.
    expect(calls[0]!.url).toBe('http://offers:3013/api/session/handoff');
    // Always the module's front door: a pane shows the module, not a screen of
    // it, because ten of the fourteen would ignore the path anyway.
    expect(calls[0]!.body).toMatchObject({ actor: 'admin', path: '/' });
  });

  it('refuses to open a module it cannot frame', async () => {
    const app = build();
    const cookie = await signIn(app);
    // No public origin.
    await request(app).get('/api/embed/mod-10-crm-lite').set('Cookie', cookie).expect(409);
    // Not framable at all.
    await request(app).get('/api/embed/mod-07-storefront').set('Cookie', cookie).expect(409);
    // Not in the stack.
    await request(app).get('/api/embed/mod-11-time-tracking').set('Cookie', cookie).expect(409);
  });

  it('passes the module’s refusal through rather than inventing one', async () => {
    const app = build(async () => new Response('{}', { status: 401 }));
    const cookie = await signIn(app);
    const res = await request(app).get('/api/embed/mod-13-offers').set('Cookie', cookie).expect(409);
    // The likeliest cause by far: SHELL_ORIGIN on that module does not name
    // this one. Saying so beats "the frame did not load".
    expect(String(res.body.error)).toMatch(/not configured to accept this shell/);
  });

  it('needs a session — a board is not a public ticket dispenser', async () => {
    const app = build();
    await request(app).get('/api/embed/mod-13-offers').expect(401);
  });
});

describe('boards belong to one person', () => {
  it('never returns another owner’s board', async () => {
    const app = createApp({
      db,
      auth,
      peers: createPeerClient({ peers: PEERS, serviceToken: TOKEN, timeoutMs: 200, fetch: stub() }),
      // Whoever signs in is whoever PS-01 said they are.
      verifyLogin: async (username) => ({ ok: true as const, actor: String(username) }),
    });

    const ada = (await request(app).post('/api/login').send({ username: 'ada@example', password: 'x' }).expect(200))
      .headers['set-cookie']![0]!.split(';')[0]!;
    const bob = (await request(app).post('/api/login').send({ username: 'bob@example', password: 'x' }).expect(200))
      .headers['set-cookie']![0]!.split(';')[0]!;

    const adasBoard = await firstBoard(app, ada);
    await request(app).post(`/api/boards/${adasBoard}/panes`).set('Cookie', ada).send({ module_id: 'mod-13-offers' }).expect(201);

    // Bob gets his own, empty.
    const bobsBoards = await request(app).get('/api/boards').set('Cookie', bob).expect(200);
    expect(bobsBoards.body.boards.map((b: { id: number }) => b.id)).not.toContain(adasBoard);

    // And cannot reach hers by id — 404, the same answer as one that never
    // existed, so an id cannot be probed for existence.
    await request(app).get(`/api/boards/${adasBoard}`).set('Cookie', bob).expect(404);
    await request(app)
      .post(`/api/boards/${adasBoard}/panes`)
      .set('Cookie', bob)
      .send({ module_id: 'mod-13-offers' })
      .expect(404);
  });
});
