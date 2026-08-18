import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, parseCookies, readToken, type AuthConfig } from '../server/auth.js';
import { createHandoff, isRedeemPath, TICKET_TTL_MS } from '../server/handoff.js';

/**
 * The shell handoff: how MOD-15 Workspace gets a signed-in view of this module
 * without a second login, and everything that must NOT be possible with it.
 *
 * The default is the load-bearing case. A module with no SHELL_ORIGIN has no
 * handoff surface at all — not a closed one, an absent one — because that is
 * what every standalone install runs and what the embed design promises.
 *
 * `server/handoff.ts` is byte-identical in every module that supports the
 * shell, and so is this suite apart from the module-relative paths it hands
 * off into — those necessarily differ, because they are each module's own.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const SERVICE_TOKEN = 'test-machine-token';
const SHELL = 'https://workspace.example';

let db: Database.Database;
/**
 * ONE app per test, deliberately.
 *
 * Unredeemed tickets live in the process that minted them, so a second
 * `createApp` is a second module as far as a ticket is concerned. That is the
 * right behaviour — a ticket is a baton, not a credential, and nothing should
 * persist it — but it means a helper that built a fresh app per request would
 * be testing two modules instead of one.
 */
let shell: Express;

function build(overrides: { serviceToken?: string; shellOrigins?: string[] } = {}): Express {
  return createApp({
    db,
    auth,
    serviceToken: SERVICE_TOKEN,
    shellOrigins: [SHELL],
    ...overrides,
  });
}

/** The ticket out of a `redeem_path`, so a test can replay or mangle it. */
function ticketOf(redeemPath: string): string {
  return new URLSearchParams(redeemPath.split('?')[1]).get('ticket')!;
}

beforeEach(() => {
  db = openDb(':memory:');
  shell = build();
});

describe('the standalone default', () => {
  it('mounts no handoff surface at all when no shell origin is configured', async () => {
    const standalone = build({ shellOrigins: [] });

    // The two /api routes are not mounted, so they fall through to the session
    // gate and answer 401 — the same answer any unauthenticated /api call
    // gets. Presenting a valid machine token does not change it, which is the
    // property that matters: a scanner cannot tell this module apart from one
    // that has never heard of a shell.
    await request(standalone).post('/api/session/handoff').set('X-Service-Token', SERVICE_TOKEN).expect(401);
    await request(standalone).post('/api/session/issue').set('X-Service-Token', SERVICE_TOKEN).expect(401);

    // The redemption route lives outside /api — with nothing mounted there is
    // simply no such path.
    await request(standalone).get('/session/handoff?ticket=anything').expect(404);
  });

  it('closes the routes when the stack has no machine token', async () => {
    const untokened = build({ serviceToken: undefined });
    await request(untokened).post('/api/session/handoff').send({ actor: 'ada@example' }).expect(401);
    await request(untokened).post('/api/session/issue').send({ actor: 'ada@example' }).expect(401);
  });
});

describe('POST /api/session/handoff', () => {
  it('requires the machine token, and a staff session is not one', async () => {
    const login = await request(shell).post('/api/login').send({ username: 'admin', password: 'test-password' });
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    await request(shell).post('/api/session/handoff').send({ actor: 'ada@example' }).expect(401);
    await request(shell).post('/api/session/handoff').set('Cookie', cookie).send({ actor: 'ada@example' }).expect(401);
    await request(shell)
      .post('/api/session/handoff')
      .set('X-Service-Token', 'wrong')
      .send({ actor: 'ada@example' })
      .expect(401);
  });

  it('mints a redeemable path for an actor', async () => {
    const res = await request(shell)
      .post('/api/session/handoff')
      .set('X-Service-Token', SERVICE_TOKEN)
      .send({ actor: 'ada@example', path: '/?view=x' })
      .expect(200);

    expect(res.body.redeem_path).toMatch(/^\/session\/handoff\?ticket=/);
    expect(Date.parse(res.body.expires_at)).toBeGreaterThan(Date.now());
  });

  it('refuses an empty actor and a destination outside this module', async () => {
    const post = (payload: unknown) =>
      request(shell).post('/api/session/handoff').set('X-Service-Token', SERVICE_TOKEN).send(payload);

    await post({}).expect(422);
    await post({ actor: '   ' }).expect(422);
    // Each of these would be an open redirect if the destination were merely
    // passed through to res.redirect. It is signed INTO the ticket instead, so
    // this check is the only place it can be rejected — and it must be.
    await post({ actor: 'ada@example', path: 'https://evil.example' }).expect(422);
    await post({ actor: 'ada@example', path: '//evil.example' }).expect(422);
    await post({ actor: 'ada@example', path: 'offers' }).expect(422);
  });
});

describe('GET /session/handoff', () => {
  async function mint(actor = 'ada@example', path = '/'): Promise<string> {
    const res = await request(shell)
      .post('/api/session/handoff')
      .set('X-Service-Token', SERVICE_TOKEN)
      .send({ actor, path })
      .expect(200);
    return res.body.redeem_path as string;
  }

  it('sets this module’s own session and lands on the signed destination', async () => {
    const redeemPath = await mint('ada@example', '/?view=x');
    const res = await request(shell).get(redeemPath).expect(302);

    expect(res.headers.location).toBe('/?view=x');
    const token = parseCookies(res.headers['set-cookie']![0]!.replace(/;/g, ';'))[COOKIE_NAME];
    // The session is a NORMAL session of this module, carrying the identity
    // the shell asserted — which is what makes the audit trail name a person.
    expect(readToken(auth, decodeURIComponent(token!))).toEqual({ actor: 'ada@example' });
  });

  it('is single use — a replayed ticket buys nothing', async () => {
    const redeemPath = await mint();
    await request(shell).get(redeemPath).expect(302);
    await request(shell).get(redeemPath).expect(401);
  });

  it('refuses a forged, mangled or absent ticket', async () => {
    await request(shell).get('/session/handoff').expect(401);
    await request(shell).get('/session/handoff?ticket=').expect(401);
    await request(shell).get('/session/handoff?ticket=not.a.real.ticket.here').expect(401);

    const redeemPath = await mint();
    const ticket = ticketOf(redeemPath);
    const parts = ticket.split('.');
    // Same expiry, same nonce, a different actor — the signature must fail.
    const forged = [parts[0], Buffer.from('root', 'utf8').toString('base64url'), parts[2], parts[3], parts[4]].join('.');
    await request(shell).get(`/session/handoff?ticket=${encodeURIComponent(forged)}`).expect(401);
    // And the real one still works, so the forgery did not consume it.
    await request(shell).get(redeemPath).expect(302);
  });

  it('does not leak whether a ticket was unknown, spent or expired', async () => {
    const redeemPath = await mint();
    await request(shell).get(redeemPath).expect(302);
    const spent = await request(shell).get(redeemPath);
    const unknown = await request(shell).get('/session/handoff?ticket=not.a.real.ticket.here');
    expect(spent.status).toBe(unknown.status);
    expect(spent.text).toBe(unknown.text);
  });
});

describe('POST /api/session/issue', () => {
  it('hands a machine caller a replayable session for the named actor', async () => {
    const res = await request(shell)
      .post('/api/session/issue')
      .set('X-Service-Token', SERVICE_TOKEN)
      .send({ actor: 'ada@example' })
      .expect(200);

    expect(res.body.cookie_name).toBe(COOKIE_NAME);
    expect(readToken(auth, res.body.token)).toEqual({ actor: 'ada@example' });

    // The point of the endpoint: the shell replays it as a Cookie header and
    // this module's ordinary session-guarded API answers.
    //
    // Asserted against /api/logout rather than /api/me, and as
    // "authenticated / not authenticated" rather than by reading a field out
    // of the body: this file is byte-identical across every module that
    // supports the shell, and /api/logout is the one guarded route all of them
    // have. WHO the session belongs to is pinned by `readToken` just above.
    await request(shell).post('/api/logout').expect(401);
    await request(shell)
      .post('/api/logout')
      .set('Cookie', `${res.body.cookie_name}=${res.body.token}`)
      .expect(200);
  });

  it('requires the machine token', async () => {
    await request(shell).post('/api/session/issue').send({ actor: 'ada@example' }).expect(401);
    await request(shell)
      .post('/api/session/issue')
      .set('X-Service-Token', 'wrong')
      .send({ actor: 'ada@example' })
      .expect(401);
  });
});

describe('the ticket itself', () => {
  it('expires, and an expired ticket is refused even before it is spent', () => {
    const handoff = createHandoff(auth);
    const at = 1_000_000;
    const { redeem_path } = handoff.issue('ada@example', '/', at);
    const ticket = ticketOf(redeem_path);

    expect(handoff.redeem(ticket, at + TICKET_TTL_MS - 1).ok).toBe(true);

    const second = createHandoff(auth);
    const later = second.issue('ada@example', '/', at);
    expect(second.redeem(ticketOf(later.redeem_path), at + TICKET_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is bound to the issuing module’s secret, so a peer’s ticket is not redeemable here', () => {
    const mine = createHandoff(auth);
    const peer = createHandoff({ ...auth, secret: 'a-different-modules-secret' });
    const { redeem_path } = peer.issue('ada@example', '/');
    expect(mine.redeem(ticketOf(redeem_path))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is not a session token, and a session token is not a ticket', () => {
    const handoff = createHandoff(auth);
    const { token } = handoff.issueSession('ada@example');
    // Domain separation: the two are signed over different prefixes, so
    // neither verifier accepts the other's output.
    expect(handoff.redeem(token).ok).toBe(false);

    const { redeem_path } = handoff.issue('ada@example', '/');
    expect(readToken(auth, ticketOf(redeem_path))).toBeNull();
  });

  it('forgets a ticket once it is redeemed, so live tickets stay bounded', () => {
    const handoff = createHandoff(auth);
    const paths = Array.from({ length: 5 }, () => handoff.issue('ada@example', '/').redeem_path);
    expect(handoff.liveTickets()).toBe(5);
    for (const path of paths) expect(handoff.redeem(ticketOf(path)).ok).toBe(true);
    expect(handoff.liveTickets()).toBe(0);
  });

  it('refuses to mint one for an empty actor or a destination it cannot sign', () => {
    const handoff = createHandoff(auth);
    expect(() => handoff.issue('', '/')).toThrow(/actor/);
    expect(() => handoff.issue('ada@example', 'https://evil.example')).toThrow(/module-relative/);
  });
});

describe('isRedeemPath', () => {
  it('accepts this module’s own paths only', () => {
    expect(isRedeemPath('/')).toBe(true);
    expect(isRedeemPath('/?view=x')).toBe(true);
    expect(isRedeemPath('//evil.example')).toBe(false);
    expect(isRedeemPath('https://evil.example')).toBe(false);
    expect(isRedeemPath('offers')).toBe(false);
    expect(isRedeemPath(undefined)).toBe(false);
  });

  /**
   * The payloads a `startsWith('//')` check waves through.
   *
   * Every one of these resolves to ANOTHER ORIGIN once a URL parser sees it —
   * which is exactly what a browser does with the `Location` header this value
   * becomes, on a response that has already set a session cookie. The second
   * assertion is the proof rather than the prose: it resolves each payload the
   * way a browser would, and requires the host to have moved.
   */
  it('refuses the payloads that only a URL parser sees as another origin', () => {
    const escapes = [
      '/\\evil.example', // a backslash IS a slash for http(s)
      '/\\/evil.example',
      '/\t/evil.example', // C0 controls are stripped before parsing
      '/\n/evil.example',
      '/\r/evil.example',
    ];
    for (const path of escapes) {
      expect(isRedeemPath(path), `accepted ${JSON.stringify(path)}`).toBe(false);
      expect(new URL(path, 'https://mine.example').host, `${JSON.stringify(path)} stayed on-origin`).not.toBe(
        'mine.example',
      );
    }
  });

  it('refuses a backslash anywhere, not only where it escapes the origin', () => {
    // `/x\y` resolves harmlessly today. It is still refused: no real module
    // path contains a backslash, and the rule is far easier to keep right when
    // it does not depend on WHERE the character sits.
    expect(isRedeemPath('/x\\y')).toBe(false);
  });

  it('refuses to mint a ticket for one, so it can never reach a Location header', () => {
    const handoff = createHandoff(auth);
    expect(() => handoff.issue('ada@example', '/\\evil.example')).toThrow(/module-relative/);
    expect(() => handoff.issue('ada@example', '/\t/evil.example')).toThrow(/module-relative/);
  });
});
