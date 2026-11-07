import express, { type Request, type Response } from 'express';
import { IdentityClient, NotificationClient, ServiceError } from '@0815software/platform-clients';
import type { AccessLevel } from '@0815software/platform-clients';
import type { ModuleInbox, ShellInbox } from '../shared/summary.js';

/**
 * The person's own corner of a shell (copy-in, MOD-15 and MOD-16): their
 * account at PS-01 — second factor, recovery codes, password, "sign out
 * everywhere" — their notifications at PS-03 — devices, briefing and wrap-up
 * times, quiet hours, what may show on the lock screen — and, for an
 * administrator, the organization's sign-in policy, the people in it, and the
 * stack's notification defaults.
 *
 * The shell DECIDES NOTHING here. Every account call goes to PS-01 with the
 * person's own PS-01 token, so PS-01 checks the password, the code and the
 * permission exactly as it would for anyone else; the shell is a form in front
 * of it. Notification calls go to PS-03 with the stack's service token for the
 * person this shell has signed in — PS-03 trusts the shell for who that is,
 * as it trusts every module for `/api/send`.
 *
 * Why the shells: they are where a person is signed in through PS-01 and
 * already looks for "my things", and they are the installed apps on the phone
 * — the ones a push notification opens.
 */

export interface IdentityVault {
  remember(actor: string, token: string): void;
  tokenFor(actor: string): string | undefined;
  forget(actor: string): void;
}

/**
 * PS-01 tokens held in memory only, never on disk or in the browser, dropped
 * on logout and after fifteen idle minutes — so changing your account needs a
 * recent sign-in, which is the point of asking for the password again anyway.
 */
export function createIdentityVault(now: () => number = Date.now, idleMs = 15 * 60_000): IdentityVault {
  const held = new Map<string, { token: string; expiresAt: number }>();
  return {
    remember(actor, token) {
      const at = now();
      for (const [k, v] of held) if (v.expiresAt <= at) held.delete(k);
      held.set(actor, { token, expiresAt: at + idleMs });
    },
    tokenFor(actor) {
      const entry = held.get(actor);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        held.delete(actor);
        return undefined;
      }
      entry.expiresAt = now() + idleMs;
      return entry.token;
    },
    forget(actor) {
      held.delete(actor);
    },
  };
}

export interface AccountOptions {
  /** PS-01, when this shell signs people in through it. */
  identity: { url: string } | null;
  /** PS-03 and the stack's service token, when notifications are configured. */
  notification: { url: string; serviceToken: string } | null;
  vault: IdentityVault;
  actorOf: (res: Response) => string;
  /** What waits for this person across the modules they can reach. */
  inbox: (actor: string) => Promise<ShellInbox>;
  fetch?: typeof fetch;
}

class AccountProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function accountRouter(opts: AccountOptions): express.Router {
  const router = express.Router();
  const fetchImpl = opts.fetch;

  const identityAs = (res: Response): { client: IdentityClient; actor: string } => {
    if (!opts.identity) throw new AccountProblem(409, 'This stack signs in locally — accounts are not managed here');
    const actor = opts.actorOf(res);
    const token = opts.vault.tokenFor(actor);
    if (!token) {
      throw new AccountProblem(401, 'Sign in again to change your account', {
        details: [{ field: 'identity', message: 'needs a recent sign-in' }],
      });
    }
    return { client: new IdentityClient({ baseUrl: opts.identity.url, identityToken: token, fetch: fetchImpl }), actor };
  };

  const notify = (): NotificationClient => {
    if (!opts.notification) throw new AccountProblem(409, 'Notifications are not configured on this stack');
    return new NotificationClient({ baseUrl: opts.notification.url, serviceToken: opts.notification.serviceToken, fetch: fetchImpl });
  };

  /** Notifications are addressed by the PS-01 email; a local admin has none. */
  const recipientOf = (res: Response): string => {
    const actor = opts.actorOf(res);
    if (!opts.identity || !actor.includes('@')) {
      throw new AccountProblem(409, 'Notifications need sign-in through PS-01 — they are addressed to a person');
    }
    return actor;
  };

  const isAdmin = async (client: IdentityClient): Promise<boolean> => {
    const me = await client.account();
    return me.permissions.includes('user:write') || me.permissions.includes('platform:admin');
  };

  /** Pass PS-01's or PS-03's own refusal through; anything else is an outage. */
  const handle =
    (work: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      work(req, res)
        .then((out) => {
          if (!res.headersSent) res.json(out);
        })
        .catch((err: unknown) => {
          if (err instanceof AccountProblem) {
            res.status(err.status).json({ ...err.body, error: err.message });
          } else if (err instanceof ServiceError && err.status >= 400 && err.status < 500) {
            // A 401 from PS-01 means the held token died (password changed,
            // signed out everywhere): drop it, so the next try says "sign in again".
            if (err.status === 401) opts.vault.forget(opts.actorOf(res));
            res.status(err.status).json(err.body ?? { error: err.message });
          } else {
            console.warn('[account] upstream unavailable:', err);
            res.status(503).json({ error: 'The account service is unavailable' });
          }
        });
    };

  // ── Account ──────────────────────────────────────────────────────────
  router.get(
    '/account',
    handle(async (_req, res) => {
      const actor = opts.actorOf(res);
      const base = { sso: opts.identity !== null, notifications: opts.notification !== null, actor };
      if (!opts.identity || !opts.vault.tokenFor(actor)) return { ...base, signed_in_recently: false };
      const { client } = identityAs(res);
      const [me, mfa] = await Promise.all([client.account(), client.mfaStatus()]);
      return {
        ...base,
        signed_in_recently: true,
        user: me.user,
        organization: me.organization,
        mfa,
        admin: me.permissions.includes('user:write') || me.permissions.includes('platform:admin'),
      };
    }),
  );

  router.post(
    '/account/mfa/setup',
    handle(async (req, res) => identityAs(res).client.mfaSetup(text(body(req).current_password))),
  );

  router.post(
    '/account/mfa/confirm',
    handle(async (req, res) => {
      const { client, actor } = identityAs(res);
      const out = await client.mfaConfirm(text(body(req).otp));
      // Switching the factor on ended every other PS-01 session, this one's
      // included; the fresh token keeps the account page working.
      opts.vault.remember(actor, out.token);
      return { totp_enabled: true, recovery_codes: out.recovery_codes };
    }),
  );

  router.post(
    '/account/mfa/disable',
    handle(async (req, res) => identityAs(res).client.mfaDisable(text(body(req).current_password), text(body(req).otp))),
  );

  router.post(
    '/account/mfa/recovery-codes',
    handle(async (req, res) =>
      identityAs(res).client.renewRecoveryCodes(text(body(req).current_password), text(body(req).otp)),
    ),
  );

  router.post(
    '/account/password',
    handle(async (req, res) => {
      const { client, actor } = identityAs(res);
      const me = await client.account();
      await client.changePassword(me.user.id, text(body(req).current_password), text(body(req).new_password));
      // A new password ends every PS-01 token, the held one included.
      opts.vault.forget(actor);
      return { ok: true };
    }),
  );

  /**
   * "I lost my phone": every other session ends at PS-01, and every other
   * device stops receiving pushes. The device asking keeps its own.
   */
  router.post(
    '/account/sessions/revoke',
    handle(async (req, res) => {
      const { client, actor } = identityAs(res);
      const out = await client.revokeMySessions();
      if (out.token) opts.vault.remember(actor, out.token);
      let devicesRemoved = 0;
      if (opts.notification) {
        const keep = text(body(req).keep_endpoint);
        devicesRemoved = (await notify().unsubscribe(actor, keep ? { except_endpoint: keep } : {})).removed;
      }
      return { revoked: true, devices_removed: devicesRemoved };
    }),
  );

  // ── Administration — PS-01 enforces the permissions ─────────────────
  router.get(
    '/admin/users',
    handle(async (_req, res) => {
      const { client } = identityAs(res);
      const [me, list] = await Promise.all([client.account(), client.users()]);
      return { organization: me.organization, users: list.users };
    }),
  );

  router.post(
    '/admin/users/:id/mfa/reset',
    handle(async (req, res) => identityAs(res).client.resetUserMfa(Number(req.params.id))),
  );

  router.post(
    '/admin/users/:id/sessions/revoke',
    handle(async (req, res) => identityAs(res).client.revokeUserSessions(Number(req.params.id))),
  );

  router.put(
    '/admin/policy',
    handle(async (req, res) => {
      const required = body(req).mfa_required;
      if (typeof required !== 'boolean') {
        throw new AccountProblem(422, 'Validation failed', { details: [{ field: 'mfa_required', message: 'must be a boolean' }] });
      }
      return identityAs(res).client.setMfaRequired(required);
    }),
  );

  /** The stack's notification defaults — only for someone PS-01 calls an administrator. */
  router.get(
    '/admin/notify-settings',
    handle(async (_req, res) => {
      if (!(await isAdmin(identityAs(res).client))) throw new AccountProblem(403, 'Only an administrator can change the defaults');
      return notify().settings();
    }),
  );

  router.put(
    '/admin/notify-settings',
    handle(async (req, res) => {
      if (!(await isAdmin(identityAs(res).client))) throw new AccountProblem(403, 'Only an administrator can change the defaults');
      return notify().setSettings(body(req) as { defaults?: Record<string, never> });
    }),
  );

  // ── Notifications for the person ─────────────────────────────────────
  router.get(
    '/notify/config',
    handle(async () => {
      if (!opts.notification) return { available: false, public_key: null };
      const { public_key } = await notify().publicKey();
      return { available: true, public_key };
    }),
  );

  router.get(
    '/notify/prefs',
    handle(async (_req, res) => notify().prefs(recipientOf(res))),
  );

  router.put(
    '/notify/prefs',
    handle(async (req, res) => notify().setPrefs(recipientOf(res), (body(req).prefs ?? {}) as Record<string, never>)),
  );

  router.get(
    '/notify/devices',
    handle(async (_req, res) => notify().devices(recipientOf(res))),
  );

  router.post(
    '/notify/devices',
    handle(async (req, res) => {
      const b = body(req);
      const device = text(b.device) || null;
      return notify().subscribe(recipientOf(res), b.subscription as never, device);
    }),
  );

  router.post(
    '/notify/devices/remove',
    handle(async (req, res) => {
      const b = body(req);
      const which = typeof b.id === 'number' ? { id: b.id } : { endpoint: text(b.endpoint) };
      if (!which.id && !which.endpoint) {
        throw new AccountProblem(422, 'Validation failed', { details: [{ field: 'endpoint', message: 'or id is required' }] });
      }
      return notify().unsubscribe(recipientOf(res), which);
    }),
  );

  router.get(
    '/notifications',
    handle(async (_req, res) => notify().notifications(recipientOf(res))),
  );

  // ── What waits for me ────────────────────────────────────────────────
  router.get(
    '/inbox',
    handle(async (_req, res) => opts.inbox(opts.actorOf(res))),
  );

  /** The badge's number: small, and asked for by the service worker on every push. */
  router.get(
    '/inbox/count',
    handle(async (_req, res) => ({ count: (await opts.inbox(opts.actorOf(res))).count })),
  );

  return router;
}

/**
 * Every module's inbox for one person, at the level PS-01 grants them there,
 * added up for the badge and merged for the "Waiting for you" page. A module
 * that cannot answer costs its own items, never the list — and is named, so a
 * short list is not mistaken for a done one.
 */
export async function collectShellInbox(
  actor: string,
  modules: readonly { id: string; label: string }[],
  levelFor: (actor: string, moduleId: string) => { ok: true; access: AccessLevel } | { ok: false },
  inboxOf: (moduleId: string, actor: string, access: AccessLevel) => Promise<{ ok: true; inbox: ModuleInbox } | { ok: false; problem: string }>,
): Promise<ShellInbox> {
  const answers = await Promise.all(
    modules.map(async (m) => {
      const level = levelFor(actor, m.id);
      if (!level.ok) return null;
      return { module: m, answer: await inboxOf(m.id, actor, level.access) };
    }),
  );
  const out: ShellInbox = { count: 0, items: [], unavailable: [] };
  for (const entry of answers) {
    if (!entry) continue;
    if (!entry.answer.ok) {
      out.unavailable.push({ module: entry.module.id, problem: entry.answer.problem });
      continue;
    }
    out.count += entry.answer.inbox.count;
    for (const item of entry.answer.inbox.items) out.items.push({ ...item, module: entry.module.id, label: entry.module.label });
  }
  // Oldest first: what has waited longest, or is due soonest, leads.
  out.items.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  return out;
}
