import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createPeerClient } from '../server/peers.js';
import { createModuleSessions } from '../server/sessions.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * Accepting a handoff — this shell, framed by another one.
 *
 * The registry has called this module `embeddable` since it existed, but the
 * routes that promise makes were never mounted. Nothing noticed, because
 * nothing framed a shell until MOD-16 Mosaic did: a Mosaic pane holding the
 * Workspace would have shown a login form instead of the board, and the only
 * clue would have been a 404 in somebody's logs.
 *
 * The default is what matters most here: with SHELL_ORIGIN unset — every
 * standalone install — none of these routes exist at all.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const TOKEN = 'test-machine-token';
const SHELL = 'https://mosaic.example';

let db: Database.Database;

function build(overrides: { serviceToken?: string; shellOrigins?: string[] } = {}): Express {
  const peers = createPeerClient({ peers: {}, serviceToken: TOKEN, timeoutMs: 200, fetch: async () => new Response('{}') });
  return createApp({
    db,
    auth,
    peers,
    sessions: createModuleSessions(peers),
    serviceToken: 'serviceToken' in overrides ? overrides.serviceToken : TOKEN,
    shellOrigins: overrides.shellOrigins ?? [SHELL],
  });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('with no shell configured', () => {
  it('has no handoff surface at all', async () => {
    const standalone = build({ shellOrigins: [] });

    // The two /api routes are not mounted, so they fall through to the session
    // gate and answer 401 — the same answer any unauthenticated /api call
    // gets. Presenting a valid machine token does not change it, which is the
    // property that matters: a scanner cannot tell this module apart from one
    // that has never heard of a shell.
    await request(standalone).post('/api/session/handoff').set('X-Service-Token', TOKEN).send({ actor: 'ada' }).expect(401);
    await request(standalone).post('/api/session/issue').set('X-Service-Token', TOKEN).send({ actor: 'ada' }).expect(401);

    // The redemption route lives outside /api — with nothing mounted there is
    // simply no such path.
    await request(standalone).get('/session/handoff?ticket=x').expect(404);
  });
});

describe('minting a ticket', () => {
  it('needs the machine token — a staff session is not one', async () => {
    const app = build();
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    await request(app).post('/api/session/handoff').send({ actor: 'ada' }).expect(401);
    await request(app).post('/api/session/handoff').set('Cookie', cookie).send({ actor: 'ada' }).expect(401);
    await request(app).post('/api/session/handoff').set('X-Service-Token', 'wrong').send({ actor: 'ada' }).expect(401);
    await request(app).post('/api/session/handoff').set('X-Service-Token', TOKEN).send({ actor: 'ada' }).expect(200);
  });

  it('is closed when the stack has no machine token', async () => {
    const app = build({ serviceToken: undefined });
    await request(app).post('/api/session/handoff').set('X-Service-Token', '').send({ actor: 'ada' }).expect(401);
  });

  it('names an actor, and refuses a path that is not module-relative', async () => {
    const app = build();
    const mint = (payload: unknown) =>
      request(app).post('/api/session/handoff').set('X-Service-Token', TOKEN).send(payload as object);

    await mint({}).expect(422);
    await mint({ actor: '   ' }).expect(422);
    // The destination is signed INTO the ticket, so this is the only place it
    // can be checked — and an absolute URL here would be an open redirect.
    await mint({ actor: 'ada', path: 'https://evil.example' }).expect(422);
    await mint({ actor: 'ada', path: '//evil.example' }).expect(422);
    await mint({ actor: 'ada', path: '/boards' }).expect(200);
  });
});

describe('redeeming a ticket', () => {
  it('signs the person in and sends them where the ticket says', async () => {
    const app = build();
    const minted = await request(app)
      .post('/api/session/handoff')
      .set('X-Service-Token', TOKEN)
      .send({ actor: 'ada@example', path: '/' })
      .expect(200);

    const redeemed = await request(app).get(minted.body.redeem_path).expect(302);
    expect(redeemed.headers['set-cookie']![0]).toMatch(/^mod15_session=/);
    expect(redeemed.headers.location).toBe('/');

    // And the session really is Ada's — this is the whole point of a handoff.
    const cookie = redeemed.headers['set-cookie']![0]!.split(';')[0]!;
    const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body.username).toBe('ada@example');
  });

  it('is single-use', async () => {
    const app = build();
    const minted = await request(app)
      .post('/api/session/handoff')
      .set('X-Service-Token', TOKEN)
      .send({ actor: 'ada@example' })
      .expect(200);

    await request(app).get(minted.body.redeem_path).expect(302);
    // A ticket is a baton, not a credential.
    await request(app).get(minted.body.redeem_path).expect(401);
  });

  it('refuses a ticket that was never issued', async () => {
    const app = build();
    await request(app).get('/session/handoff?ticket=made-up').expect(401);
    await request(app).get('/session/handoff').expect(401);
  });
});

describe('issuing a session directly', () => {
  it('hands the machine caller a replayable cookie for that person', async () => {
    const app = build();
    const issued = await request(app)
      .post('/api/session/issue')
      .set('X-Service-Token', TOKEN)
      .send({ actor: 'ada@example' })
      .expect(200);

    expect(issued.body.cookie_name).toBe('mod15_session');
    const me = await request(app)
      .get('/api/me')
      .set('Cookie', `${issued.body.cookie_name}=${issued.body.token}`)
      .expect(200);
    expect(me.body.username).toBe('ada@example');
  });
});
