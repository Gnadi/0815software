import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createPeerClient } from '../server/peers.js';
import { createModuleSessions } from '../server/sessions.js';
import type { AuthConfig } from '../server/auth.js';
import type { Board } from '../shared/types.js';

/**
 * Boards, widgets and the context bar — the part of the Workspace that is its
 * own application rather than a view onto other modules.
 *
 * The isolation cases carry the most weight. Boards are per person, and "per
 * person" has to mean a query that cannot reach someone else's row, not a UI
 * that does not offer a way to. Everything else here is about a layout
 * surviving what people actually do to it.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let db: Database.Database;
let app: Express;
let cookie: string;

/**
 * Sign in as a named person.
 *
 * Standalone, every operator signs in through the one local admin account, so
 * "per person" only becomes observable once PS-01 is validating logins — which
 * is exactly the deployment where two people share a stack. The injected
 * verifier below stands in for PS-01 saying yes and naming who it said yes to,
 * the same shape `sso.ts` returns.
 */
async function signIn(username = 'admin'): Promise<string> {
  const res = await request(app).post('/api/login').send({ username, password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function firstBoard(as = cookie): Promise<Board> {
  const res = await request(app).get('/api/boards').set('Cookie', as).expect(200);
  return res.body.boards[0] as Board;
}

beforeEach(async () => {
  db = openDb(':memory:');
  const peers = createPeerClient({ peers: {}, timeoutMs: 100 });
  app = createApp({
    db,
    auth,
    peers,
    sessions: createModuleSessions(peers),
    verifyLogin: async (username, password) =>
      password === 'test-password' && typeof username === 'string' && username !== ''
        ? { ok: true, actor: username }
        : { ok: false, reason: 'rejected' },
  });
  cookie = await signIn();
});

describe('authentication', () => {
  it('gates everything except health, ready and login', async () => {
    await request(app).get('/api/health').expect(200).expect({ ok: true });
    // The BODY, not just the status: the stack's pre-flight
    // (`deploy/smoke-stack.mjs`) reads `ready`, and this module used to answer
    // `{ ok: true }` here — a 200 that failed the check that matters.
    await request(app).get('/api/ready').expect(200).expect({ ready: true });
    for (const path of ['/api/boards', '/api/catalogue', '/api/summaries', '/api/activity', '/api/me']) {
      await request(app).get(path).expect(401);
    }
  });
});

describe('a person’s first visit', () => {
  it('creates a starter board with the two widgets that work with no peers', async () => {
    const res = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
    expect(res.body.boards).toHaveLength(1);

    const kinds = (res.body.boards[0] as Board).widgets.map((w) => w.kind).sort();
    // A launcher and the activity feed need no module to render something
    // true, so a fresh standalone install is never a blank grid.
    expect(kinds).toEqual(['activity', 'launcher']);
  });

  it('does not create a second one on the next visit', async () => {
    await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
    const again = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
    expect(again.body.boards).toHaveLength(1);
  });
});

describe('boards are per person', () => {
  it('gives two people separate boards, and neither can see the other’s', async () => {
    const ada = await signIn('ada');
    const bob = await signIn('bob');

    const adaBoard = await firstBoard(ada);
    await request(app).post('/api/boards').set('Cookie', ada).send({ name: 'Ada’s second' }).expect(201);

    const bobBoards = await request(app).get('/api/boards').set('Cookie', bob).expect(200);
    expect(bobBoards.body.boards).toHaveLength(1);
    expect(bobBoards.body.boards[0].name).not.toBe('Ada’s second');

    // 404, not 403: a board belonging to someone else is indistinguishable
    // from one that does not exist.
    await request(app).get(`/api/boards/${adaBoard.id}`).set('Cookie', bob).expect(404);
    await request(app).put(`/api/boards/${adaBoard.id}`).set('Cookie', bob).send({ name: 'mine now' }).expect(404);
    await request(app).delete(`/api/boards/${adaBoard.id}`).set('Cookie', bob).expect(404);
    await request(app).post(`/api/boards/${adaBoard.id}/widgets`).set('Cookie', bob).send({ kind: 'activity' }).expect(404);
  });
});

describe('boards', () => {
  it('creates, renames and deletes', async () => {
    await firstBoard(); // the starter board, so this is not the only one
    const created = await request(app).post('/api/boards').set('Cookie', cookie).send({ name: 'Finance' }).expect(201);
    expect(created.body.name).toBe('Finance');

    const renamed = await request(app)
      .put(`/api/boards/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Money' })
      .expect(200);
    expect(renamed.body.name).toBe('Money');

    await request(app).delete(`/api/boards/${created.body.id}`).set('Cookie', cookie).expect(200);
    const left = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
    expect(left.body.boards).toHaveLength(1);
  });

  it('refuses to delete the last one', async () => {
    const board = await firstBoard();
    // Deleting it would leave a screen with no board and no way to make one.
    await request(app).delete(`/api/boards/${board.id}`).set('Cookie', cookie).expect(409);
  });

  it('refuses a nameless or oversized name', async () => {
    await request(app).post('/api/boards').set('Cookie', cookie).send({}).expect(422);
    await request(app).post('/api/boards').set('Cookie', cookie).send({ name: '   ' }).expect(422);
    await request(app).post('/api/boards').set('Cookie', cookie).send({ name: 'x'.repeat(61) }).expect(422);
  });

  it('remembers which board someone was on', async () => {
    const second = await request(app).post('/api/boards').set('Cookie', cookie).send({ name: 'Second' }).expect(201);
    await request(app).post(`/api/boards/${second.body.id}/active`).set('Cookie', cookie).expect(200);

    const res = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
    expect(res.body.preferences.active_board).toBe(second.body.id);
  });
});

describe('widgets', () => {
  it('adds a peer-fed widget and a shell-owned one', async () => {
    const board = await firstBoard();
    await request(app)
      .post(`/api/boards/${board.id}/widgets`)
      .set('Cookie', cookie)
      .send({ kind: 'tile', module_id: 'mod-13-offers', widget_key: 'open', x: 0, y: 4, w: 3, h: 2 })
      .expect(201);
    await request(app).post(`/api/boards/${board.id}/widgets`).set('Cookie', cookie).send({ kind: 'launcher' }).expect(201);

    const after = await firstBoard();
    expect(after.widgets).toHaveLength(4);
  });

  it('refuses a widget whose reference is half-filled', async () => {
    const board = await firstBoard();
    const add = (widget: unknown) => request(app).post(`/api/boards/${board.id}/widgets`).set('Cookie', cookie).send(widget);

    // A tile without a module has nothing to read; a launcher WITH one implies
    // a relationship the Workspace does not have. Both are unrepresentable in
    // the schema, and both get a field-level reason rather than a 500.
    await add({ kind: 'tile' }).expect(422);
    await add({ kind: 'tile', module_id: 'mod-13-offers' }).expect(422);
    await add({ kind: 'launcher', module_id: 'mod-13-offers' }).expect(422);
    await add({ kind: 'nonsense' }).expect(422);
  });

  it('refuses a widget that would hang off the right edge of the grid', async () => {
    const board = await firstBoard();
    const res = await request(app)
      .post(`/api/boards/${board.id}/widgets`)
      .set('Cookie', cookie)
      .send({ kind: 'activity', x: 10, w: 6 })
      .expect(422);
    expect(res.body.details[0].field).toBe('w');
  });

  it('removes one, and 404s on a widget from another board', async () => {
    const board = await firstBoard();
    const other = await request(app).post('/api/boards').set('Cookie', cookie).send({ name: 'Other' }).expect(201);
    const widget = board.widgets[0]!;

    await request(app).delete(`/api/boards/${other.body.id}/widgets/${widget.id}`).set('Cookie', cookie).expect(404);
    await request(app).delete(`/api/boards/${board.id}/widgets/${widget.id}`).set('Cookie', cookie).expect(200);
    expect((await firstBoard()).widgets).toHaveLength(1);
  });
});

describe('layout', () => {
  it('applies a whole arrangement at once', async () => {
    const board = await firstBoard();
    const moved = board.widgets.map((w, i) => ({ id: w.id, x: i * 3, y: i + 1, w: 3, h: 2 }));

    const res = await request(app)
      .put(`/api/boards/${board.id}/layout`)
      .set('Cookie', cookie)
      .send({ widgets: moved })
      .expect(200);

    expect((res.body as Board).widgets.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }))).toEqual(
      moved.map(({ x, y, w, h }) => ({ x, y, w, h })),
    );
  });

  it('leaves the board untouched when any placement is invalid', async () => {
    const board = await firstBoard();
    const before = board.widgets.map((w) => ({ id: w.id, x: w.x, y: w.y }));

    await request(app)
      .put(`/api/boards/${board.id}/layout`)
      .set('Cookie', cookie)
      .send({ widgets: [{ id: board.widgets[0]!.id, x: 0, y: 9, w: 4, h: 2 }, { id: 999_999, x: 0, y: 0, w: 3, h: 2 }] })
      .expect(404);

    // The half-applied outcome is the one to avoid: a layout that is neither
    // the old one nor the new one, which nobody can undo.
    const after = await firstBoard();
    expect(after.widgets.map((w) => ({ id: w.id, x: w.x, y: w.y }))).toEqual(before);
  });

  it('refuses a placement wider than the grid allows at that column', async () => {
    const board = await firstBoard();
    await request(app)
      .put(`/api/boards/${board.id}/layout`)
      .set('Cookie', cookie)
      .send({ widgets: [{ id: board.widgets[0]!.id, x: 9, y: 0, w: 6, h: 2 }] })
      .expect(422);
  });

  it('refuses a body that is not a list of placements', async () => {
    const board = await firstBoard();
    await request(app).put(`/api/boards/${board.id}/layout`).set('Cookie', cookie).send({}).expect(422);
  });
});

describe('the shared context', () => {
  it('stores a customer and a date range, and hands them back', async () => {
    const res = await request(app)
      .put('/api/context')
      .set('Cookie', cookie)
      .send({ party: 77, party_name: 'Blaustern', from: '2026-01-01', to: '2026-12-31' })
      .expect(200);
    expect(res.body.context).toEqual({ party: 77, party_name: 'Blaustern', from: '2026-01-01', to: '2026-12-31' });

    const boards = await request(app).get('/api/boards').set('Cookie', cookie).expect(200);
    expect(boards.body.preferences.context.party).toBe(77);
  });

  it('clears back to everything', async () => {
    await request(app).put('/api/context').set('Cookie', cookie).send({ party: 77 }).expect(200);
    const cleared = await request(app).put('/api/context').set('Cookie', cookie).send({}).expect(200);
    expect(cleared.body.context).toEqual({});
  });

  /**
   * Stricter than the summary contract's parser, deliberately: that one reads a
   * transient query string, this one persists a choice. A stored context nobody
   * can honour would silently filter every board this person opens from now on.
   */
  it('refuses what it cannot honour rather than storing it', async () => {
    await request(app).put('/api/context').set('Cookie', cookie).send({ party: 'nonsense' }).expect(422);
    await request(app).put('/api/context').set('Cookie', cookie).send({ party: -1 }).expect(422);
    await request(app).put('/api/context').set('Cookie', cookie).send({ from: 'yesterday' }).expect(422);
    await request(app)
      .put('/api/context')
      .set('Cookie', cookie)
      .send({ from: '2026-12-31', to: '2026-01-01' })
      .expect(422);
  });

  it('is per person, like the boards', async () => {
    const ada = await signIn('ada');
    const bob = await signIn('bob');
    await request(app).put('/api/context').set('Cookie', ada).send({ party: 77 }).expect(200);

    const bobBoards = await request(app).get('/api/boards').set('Cookie', bob).expect(200);
    expect(bobBoards.body.preferences.context).toEqual({});
  });
});
