import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createToken, sessionCookie, COOKIE_NAME } from './auth.js';
import type { AuthConfig } from './auth.js';

/**
 * SHELL HANDOFF (copy-in, standalone). How MOD-15 Workspace gets a signed-in
 * view of this module without asking the operator to log in twice.
 *
 * The stance is the same one `sso.ts` takes about PS-01: **this module remains
 * the sole authority over its own sessions.** The shell never mints one, never
 * sees a cookie it did not receive through here, and cannot extend a session's
 * lifetime. All it can do is say "this is who is using me" — and it may only
 * say that because it presents the stack's machine token AND the operator
 * explicitly named it in `SHELL_ORIGIN`.
 *
 * Two ways in, because the shell needs both:
 *
 * - **`POST /api/session/handoff`** mints a single-use ticket and returns the
 *   path that redeems it. The shell puts that path on an iframe's `src`, the
 *   browser lands here, gets this module's own cookie and is redirected to the
 *   embedded view. This is what makes the module usable inside the board.
 * - **`POST /api/session/issue`** returns a session token directly to the
 *   machine caller, which the shell replays as a `Cookie` header when it calls
 *   this module's ordinary session-guarded API on the user's behalf. This is
 *   what lets a button on the board do real work — and it is why the resulting
 *   audit entries and history rows name the person, not a service account.
 *
 * Both are closed unless `SHELL_ORIGIN` is set, so the standalone module has no
 * such surface at all: the routes are never mounted.
 *
 * Four properties the tests pin down:
 *
 * 1. **Domain separation.** Tickets are signed over `handoff.…`, sessions over
 *    `session.…` (`auth.ts`). Neither is a valid input to the other's verifier,
 *    so a leaked ticket is not a session and a stolen session is not a ticket.
 * 2. **The destination is signed, not passed.** The path the browser is sent to
 *    afterwards is inside the ticket. `/session/handoff` therefore takes no
 *    redirect parameter and cannot be turned into an open redirect — the
 *    obvious way to get this wrong.
 * 3. **Single use, 30 seconds.** A ticket is remembered when issued and
 *    forgotten when redeemed, so a replay finds nothing to redeem. A ticket
 *    that reaches a log or a `Referer` header has almost certainly expired
 *    before anyone could read it there.
 * 4. **Bound to this module.** The signing key is this module's own
 *    `SESSION_SECRET`, so a ticket minted by one module in the stack is not
 *    redeemable at another even though both trust the same shell.
 */

/** How long a ticket may be redeemed for. Deliberately short — it is a baton. */
export const TICKET_TTL_MS = 30_000;

/** Minimum gap between prunes of the issued-ticket map. */
const PRUNE_INTERVAL_MS = 60_000;

/**
 * An upper bound on live tickets, so a caller holding the service token cannot
 * grow this process's memory without bound by minting and never redeeming.
 * At a 30-second TTL this is far above any real board's refresh rate.
 */
const MAX_LIVE_TICKETS = 10_000;

/**
 * The path a shell may hand off into — rooted, this module's own space.
 *
 * This is the single most security-sensitive check in the file, because the
 * value ends up in a `Location` header on a response that has ALREADY set a
 * session cookie. A path that escapes the origin here is an open redirect
 * immediately after a login, which is the classic way a session gets handed to
 * somebody else's page.
 *
 * A prefix check alone does not do it, because a URL parser and `startsWith`
 * disagree about what an origin is:
 *
 * - `//host/x` and `https://host/x` are other origins outright.
 * - **`/\host/x` is too.** For http(s) the URL standard reads a backslash as a
 *   forward slash, so the browser resolves this as `//host/x` even though
 *   `startsWith('//')` is false. Any backslash is refused.
 * - **C0 controls are stripped before parsing**, so `/<tab>/host` becomes
 *   `//host` by the time it is resolved — after any check on the raw string.
 * - A bare `x` resolves against wherever the browser happens to be.
 *
 * Identical to `shared/summary.ts:isModulePath`, which guards the same value on
 * the shell's side. If you change one, change both.
 */
export function isRedeemPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/')) return false;
  if (/[\u0000-\u001F\u007F]/.test(path)) return false;
  if (path.includes('\\')) return false;
  return !path.startsWith('//');
}

/**
 * Constant-time string compare.
 *
 * Defined here rather than imported from `auth.js` on purpose: this file is
 * copy-in and byte-identical across every module that supports the shell, and
 * only two of the fourteen `auth.ts` copies export their own version. Importing
 * one would make this file depend on a detail that varies per module, which is
 * exactly what a copy-in file must not do.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time compare for the machine token, so every module gets one from
 * this file whether or not its own `auth.ts` exports one.
 */
export function safeServiceTokenEqual(a: string, b: string): boolean {
  return safeCompare(a, b);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`handoff.${payload}`).digest('hex');
}

export interface IssuedTicket {
  /** Path on THIS module that redeems the ticket, query string included. */
  redeem_path: string;
  /** ISO timestamp after which the ticket is refused. */
  expires_at: string;
}

export interface IssuedSession {
  /** The cookie this module authenticates with, for a machine caller to replay. */
  cookie_name: string;
  token: string;
  expires_at: string;
}

export type RedeemResult =
  | { ok: true; cookie: string; location: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'unknown' };

export interface Handoff {
  /** Mint a single-use ticket for `actor`, landing on `path` once redeemed. */
  issue(actor: string, path: string, now?: number): IssuedTicket;
  /** Mint a session token for `actor` for a machine caller to replay. */
  issueSession(actor: string, now?: number): IssuedSession;
  /** Redeem a ticket. Never throws — a bad ticket is a verdict, not an error. */
  redeem(ticket: unknown, now?: number): RedeemResult;
  /** Live ticket count. Exposed for tests and for the prune assertions. */
  liveTickets(): number;
}

export function createHandoff(auth: AuthConfig): Handoff {
  /** nonce -> expiry. Presence is what makes a ticket redeemable exactly once. */
  const issued = new Map<string, number>();
  let prunedAt = -Infinity;

  const prune = (now: number, force = false): void => {
    if (!force && now - prunedAt < PRUNE_INTERVAL_MS) return;
    prunedAt = now;
    for (const [nonce, expiry] of issued) if (expiry <= now) issued.delete(nonce);
  };

  return {
    issue(actor: string, path: string, now = Date.now()): IssuedTicket {
      if (actor === '') throw new Error('handoff actor must not be empty');
      if (!isRedeemPath(path)) throw new Error(`handoff path must be module-relative — got ${JSON.stringify(path)}`);

      prune(now);
      if (issued.size >= MAX_LIVE_TICKETS) {
        // Prune unconditionally before refusing: at this size the map is
        // almost certainly full of tickets nobody redeemed rather than of
        // tickets in flight.
        prune(now, true);
        if (issued.size >= MAX_LIVE_TICKETS) throw new Error('too many unredeemed handoff tickets');
      }

      const expiry = now + TICKET_TTL_MS;
      const nonce = randomBytes(16).toString('base64url');
      const payload = [
        String(expiry),
        Buffer.from(actor, 'utf8').toString('base64url'),
        Buffer.from(path, 'utf8').toString('base64url'),
        nonce,
      ].join('.');
      issued.set(nonce, expiry);

      return {
        redeem_path: `/session/handoff?ticket=${encodeURIComponent(`${payload}.${sign(payload, auth.secret)}`)}`,
        expires_at: new Date(expiry).toISOString(),
      };
    },

    issueSession(actor: string, now = Date.now()): IssuedSession {
      if (actor === '') throw new Error('handoff actor must not be empty');
      return {
        cookie_name: COOKIE_NAME,
        token: createToken(auth, actor, now),
        expires_at: new Date(now + auth.ttlHours * 3600_000).toISOString(),
      };
    },

    redeem(ticket: unknown, now = Date.now()): RedeemResult {
      if (typeof ticket !== 'string') return { ok: false, reason: 'malformed' };
      const parts = ticket.split('.');
      if (parts.length !== 5) return { ok: false, reason: 'malformed' };
      const [expiry, actorPart, pathPart, nonce, mac] = parts as [string, string, string, string, string];
      if (!/^\d+$/.test(expiry)) return { ok: false, reason: 'malformed' };

      const payload = `${expiry}.${actorPart}.${pathPart}.${nonce}`;
      // Signature first: an unsigned ticket must not be able to probe which
      // nonces this process has issued through a difference in the answer.
      if (!safeCompare(mac, sign(payload, auth.secret))) return { ok: false, reason: 'malformed' };
      if (Number(expiry) <= now) {
        issued.delete(nonce);
        return { ok: false, reason: 'expired' };
      }
      // Deleting IS the single-use check: a second redemption finds nothing.
      if (!issued.delete(nonce)) return { ok: false, reason: 'unknown' };

      const actor = Buffer.from(actorPart, 'base64url').toString('utf8');
      const path = Buffer.from(pathPart, 'base64url').toString('utf8');
      if (actor === '' || !isRedeemPath(path)) return { ok: false, reason: 'malformed' };

      prune(now);
      return { ok: true, cookie: sessionCookie(auth, createToken(auth, actor, now)), location: path };
    },

    liveTickets(): number {
      return issued.size;
    },
  };
}
