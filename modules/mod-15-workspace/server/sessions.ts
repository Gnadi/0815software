import type { PeerClient } from './peers.js';

/**
 * The module-session vault.
 *
 * When the board runs an action, it calls the target module's ordinary,
 * session-guarded route with a session belonging to WHOEVER CLICKED. This holds
 * those sessions, one per (actor, module) pair, obtained through the module's
 * own `/api/session/issue`.
 *
 * That indirection is the whole reason cross-module actions need no new write
 * API anywhere: the target sees a normal request from a normal user, authorizes
 * it exactly as it would from its own screens, and records the person in its
 * audit trail and history rows. A shell that used the machine token instead
 * would be a service account doing everyone's work, and every module's history
 * would say so.
 *
 * Four properties, each one deliberate:
 *
 * - **In memory only.** Nothing is written to disk. A restart costs a round
 *   trip, and a stolen database file contains no credential for any peer.
 * - **Never sent to the browser.** These live entirely server-side; the client
 *   asks the Workspace to run an action and gets a result, not a token.
 * - **Re-minted before they lapse.** Held sessions are discarded a minute
 *   early, so an action never fails on a session that expired mid-flight.
 * - **Bounded.** Entries are pruned on access, and the map is keyed by actor
 *   and module, so it is at most (people) × (modules) — not per request.
 */

/** Discard a held session this long before it actually expires. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * How long to hold one after it was last USED, regardless of what the peer says.
 *
 * A module's SESSION_TTL_HOURS may be twelve; keeping a session that long in
 * a process that never sees the person again means an action could run under
 * an identity that logged out hours ago. Fifteen minutes keeps the vault close
 * to "someone is using the board right now".
 *
 * IDLE time, not total time — the distinction is the whole point, and getting
 * it wrong broke the thing this module exists to get right. As a fixed window
 * from login it expired under an open board: the shell session lasts twelve
 * hours, so at minute sixteen the PS-07 read lost its principal, came back
 * 401, and the feed rendered "NOTHING RECORDED YET" over a full audit log —
 * exactly the misleading empty state db.ts and platform.ts both argue against.
 * A board being read every minute is the clearest possible evidence that
 * someone is using it, so reading extends the hold and only real idleness
 * ends it.
 */
const MAX_IDLE_MS = 15 * 60_000;

interface Held {
  cookie: string;
  expiresAt: number;
}

export interface ModuleSessions {
  /**
   * Remember the PS-01 token a person logged in with, so reads that take an
   * identity (PS-07's audit trail) can be made as them. Same rules as the
   * module sessions below: memory only, never to disk, never to the browser,
   * dropped on logout.
   */
  rememberIdentity(actor: string, token: string): void;
  /**
   * That token, if this process still holds one for them — and, because a read
   * is proof the person is still here, extends the hold by another idle window.
   */
  identityFor(actor: string): string | undefined;
  /**
   * A session cookie for this person at this module, minting one if needed.
   * Never throws — a peer that will not issue one is a problem string.
   */
  cookieFor(actor: string, moduleId: string): Promise<{ ok: true; cookie: string } | { ok: false; problem: string }>;
  /** Forget everything held for one person (used on logout). */
  forget(actor: string): void;
  /** Held session count, for tests and for the prune assertions. */
  size(): number;
}

export function createModuleSessions(peers: PeerClient, now: () => number = Date.now): ModuleSessions {
  const held = new Map<string, Held>();
  /**
   * PS-01 tokens, bounded exactly like the module sessions below.
   *
   * Without an expiry this map would hold one credential per person who ever
   * signed in, for as long as the process lived — a slow leak, and a token
   * kept far longer than the session it came from.
   */
  const identities = new Map<string, { token: string; expiresAt: number }>();

  /**
   * Keys are joined on NUL, written as an escape so it is visible here.
   *
   * A space would be ambiguous: actor `ada b` + module `c` and actor `ada` +
   * module `b c` would produce the same key, and `forget('ada')` would then
   * also drop the other person's sessions. NUL cannot occur in an email or a
   * module id, so the join is unambiguous.
   */
  const key = (actor: string, moduleId: string): string => `${actor}\u0000${moduleId}`;

  const prune = (at: number): void => {
    for (const [k, session] of held) if (session.expiresAt <= at) held.delete(k);
    for (const [k, identity] of identities) if (identity.expiresAt <= at) identities.delete(k);
  };

  return {
    rememberIdentity(actor: string, token: string): void {
      const at = now();
      prune(at);
      identities.set(actor, { token, expiresAt: at + MAX_IDLE_MS });
    },

    identityFor(actor: string): string | undefined {
      const at = now();
      const identity = identities.get(actor);
      if (!identity) return undefined;
      if (identity.expiresAt <= at) {
        identities.delete(actor);
        return undefined;
      }
      // Sliding, not fixed: this read means the board is being looked at.
      identity.expiresAt = at + MAX_IDLE_MS;
      return identity.token;
    },

    async cookieFor(actor: string, moduleId: string) {
      const at = now();
      prune(at);

      const existing = held.get(key(actor, moduleId));
      if (existing && existing.expiresAt > at + REFRESH_MARGIN_MS) {
        return { ok: true as const, cookie: existing.cookie };
      }

      const issued = await peers.issueSession(moduleId, actor);
      if (!issued.ok) return issued;

      held.set(key(actor, moduleId), { cookie: issued.cookie, expiresAt: at + MAX_IDLE_MS });
      return { ok: true as const, cookie: issued.cookie };
    },

    forget(actor: string): void {
      for (const k of held.keys()) if (k.startsWith(`${actor}\u0000`)) held.delete(k);
      identities.delete(actor);
    },

    size(): number {
      prune(now());
      return held.size;
    },
  };
}
