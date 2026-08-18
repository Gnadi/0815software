import { IdentityClient, ServiceError } from '@0815software/platform-clients';

/**
 * SSO login-exchange (copy-in, standalone). When IDENTITY_URL + IDENTITY_ORG
 * are set, PS-01 Identity validates the admin login and must grant the
 * required permission (default `platform:admin`); the module then issues its
 * OWN local session exactly as before — only credential validation is
 * delegated. When unset, mod-16 falls back to its local admin credentials.
 */

/**
 * `null` -> SSO not configured, the caller should use local credentials.
 * Otherwise the verdict, and on success WHO PS-01 says this is — the module
 * stamps that on everything the resulting session goes on to do.
 */
export type LoginOutcome =
  | {
      ok: true;
      actor: string;
      /**
       * The PS-01 session token that validated this login.
       *
       * Carried out of the exchange because some Platform Services gate their
       * READS behind a principal rather than the machine token — PS-07 Audit
       * Log is the one that matters here: any module may WRITE an event with
       * the stack's service token, but reading the trail takes an identity,
       * which is the right boundary for a log of everyone's actions. Forwarding
       * this token as `Authorization: Bearer` is the sanctioned
       * identity-propagation path (`ClientOptions.identityToken`), and it means
       * a shell reads the audit log AS the person looking at the board,
       * with exactly their authority — not with a borrowed admin account.
       */
      identityToken: string;
    }
  | { ok: false; reason: 'rejected' | 'unavailable' }
  | null;
export type LoginVerifier = (username: unknown, password: unknown) => Promise<LoginOutcome>;

export interface SsoConfig {
  /** PS-01 base URL. Unset -> SSO off (local credentials). */
  identityUrl?: string;
  /** PS-01 org slug users authenticate against. */
  identityOrg?: string;
  /** Permission the PS-01 user must hold (default `platform:admin`). */
  identityPermission?: string;
}

/** Standalone default: defer to local credentials. */
export const nullVerifier: LoginVerifier = async () => null;

/**
 * Which credentials a deployment actually accepts. The login form reads this
 * (GET /api/auth-mode) to name the right ones: with SSO configured the local
 * admin login is rejected, so a form still advertising it points people at a
 * password that cannot work. Derived from the same two fields the verifier
 * switches on, so hint and behaviour cannot drift apart.
 */
export type LoginMode = { sso: false } | { sso: true; org: string };

/** The standalone default: this module's own credentials. */
export const LOCAL_LOGIN: LoginMode = { sso: false };

/** The configured PS-01 target, or null when SSO is off. Checked once, read twice. */
function ssoTarget(cfg: SsoConfig): { url: string; org: string } | null {
  return cfg.identityUrl && cfg.identityOrg ? { url: cfg.identityUrl, org: cfg.identityOrg } : null;
}

export function loginModeOf(cfg: SsoConfig): LoginMode {
  const target = ssoTarget(cfg);
  return target ? { sso: true, org: target.org } : LOCAL_LOGIN;
}

export function buildLoginVerifier(cfg: SsoConfig): LoginVerifier {
  const target = ssoTarget(cfg);
  if (!target) return nullVerifier;
  const org = target.org;
  const permission = cfg.identityPermission ?? 'platform:admin';
  const client = new IdentityClient({ baseUrl: target.url });
  return async (username, password): Promise<LoginOutcome> => {
    if (typeof username !== 'string' || typeof password !== 'string') return { ok: false, reason: 'rejected' };
    try {
      const { token, user } = await client.login(org, username, password);
      const verdict = await client.verify(token);
      if (!verdict.valid) return { ok: false, reason: 'rejected' };
      // PS-01 returns the principal's permissions on verify (Phase 1).
      const perms = (verdict as { permissions?: string[] }).permissions ?? [];
      if (permission && !perms.includes(permission)) return { ok: false, reason: 'rejected' };
      // The PS-01 email is the identity worth recording: stable, unique within
      // the organization, and readable by whoever reads the trail later.
      return { ok: true, actor: user.email, identityToken: token };
    } catch (err) {
      // Both fail closed — SSO, once configured, is never silently bypassed by
      // the local fallback. They are not the same answer to the caller though.
      // PS-01 answering "no" is a rejected credential; PS-01 being unreachable
      // is an outage, and reporting one as the other sends a user off to reset
      // a password that was never wrong while hiding a broken deployment from
      // whoever has to fix it.
      if (err instanceof ServiceError) return { ok: false, reason: 'rejected' };
      console.warn('[mod-16] identity login unavailable:', err);
      return { ok: false, reason: 'unavailable' };
    }
  };
}
