import { IdentityClient, ServiceError } from '@0815software/platform-clients';

/**
 * SSO login-exchange (copy-in, standalone). When IDENTITY_URL + IDENTITY_ORG
 * are set, PS-01 Identity validates the admin login and must grant the
 * required permission (default `platform:admin`); the module then issues its
 * OWN local session exactly as before — only credential validation is
 * delegated. When unset, mod-03 falls back to its local admin credentials.
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

export function buildLoginVerifier(cfg: SsoConfig): LoginVerifier {
  if (!cfg.identityUrl || !cfg.identityOrg) return nullVerifier;
  const org = cfg.identityOrg;
  const permission = cfg.identityPermission ?? 'platform:admin';
  const client = new IdentityClient({ baseUrl: cfg.identityUrl });
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
      if (err instanceof ServiceError) return { ok: false, reason: 'rejected' };
      console.warn('[mod-03] identity login unavailable:', err);
      return { ok: false, reason: 'unavailable' };
    }
  };
}
