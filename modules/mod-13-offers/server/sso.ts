import { IdentityClient, ServiceError } from '@0815software/platform-clients';

/**
 * SSO login-exchange (copy-in, standalone). When IDENTITY_URL + IDENTITY_ORG
 * are set, PS-01 Identity validates the admin login and must grant the
 * required permission (default `platform:admin`); the module then issues its
 * OWN local session exactly as before — only credential validation is
 * delegated. When unset, mod-13 falls back to its local admin credentials.
 */

/**
 * `null` -> SSO not configured, the caller should use local credentials.
 * Otherwise the verdict, and on success WHO PS-01 says this is — the module
 * stamps that on everything the resulting session goes on to do.
 */
export type LoginOutcome =
  | { ok: true; actor: string }
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
      return { ok: true, actor: user.email };
    } catch (err) {
      // Both fail closed — SSO, once configured, is never silently bypassed by
      // the local fallback. They are not the same answer to the caller though.
      // PS-01 answering "no" is a rejected credential; PS-01 being unreachable
      // is an outage, and reporting one as the other sends a user off to reset
      // a password that was never wrong while hiding a broken deployment from
      // whoever has to fix it.
      //
      // "PS-01 answered at all" was the test, and it is the wrong one:
      // `ServiceError` is raised for EVERY non-2xx, so a 500 from a
      // half-broken PS-01 and a 429 from its own login throttle both arrived
      // here as a wrong password. What is a verdict about the CREDENTIAL is a
      // 4xx that is not 429 — 401 for the wrong password, 403 for a missing
      // permission, 422 for a malformed request. A 5xx is the service failing,
      // and a 429 is it declining to answer yet; neither says anything about
      // whether the password was right.
      const verdictAboutTheCredential =
        err instanceof ServiceError && err.status >= 400 && err.status < 500 && err.status !== 429;
      if (verdictAboutTheCredential) return { ok: false, reason: 'rejected' };
      console.warn('[mod-13] identity login unavailable:', err);
      return { ok: false, reason: 'unavailable' };
    }
  };
}
