import { BaseClient, ServiceError } from './http.js';
import type { LoginResult, TokenVerdict } from './types.js';

/** Client for PS-01 Identity (default port 4001). */
export class IdentityClient extends BaseClient {
  /**
   * Authenticate an end user; returns a PS-01 session token. `otp` is the
   * second factor — a six-digit code or a recovery code — for an account that
   * has one; see `secondFactorRefusal` for telling "needs a code" apart.
   */
  login(orgSlug: string, email: string, password: string, otp?: string): Promise<LoginResult> {
    return this.apiPost<LoginResult>('/api/login', {
      org_slug: orgSlug,
      email,
      password,
      ...(otp ? { otp } : {}),
    });
  }

  /** The cross-service contract: validate a session token and return its claims. */
  verify(token: string): Promise<TokenVerdict> {
    return this.apiPost<TokenVerdict>('/api/tokens/verify', { token });
  }

  /** Current principal (uses the forwarded identity token). */
  me(): Promise<{ user: unknown; roles: unknown[]; permissions: string[] }> {
    return this.apiGet('/api/me');
  }

  listUsers(): Promise<unknown[]> {
    return this.apiGet('/api/users');
  }
}

/**
 * Whether a refused PS-01 login was about the SECOND factor, and which way:
 * `required` — the password was right and the account wants a code (show the
 * code field), `invalid` — the code was wrong. Anything else is `null`, and the
 * caller treats it as it always did. Read from the error's field details
 * rather than its wording, which is for people.
 */
export function secondFactorRefusal(err: unknown): 'required' | 'invalid' | null {
  if (!(err instanceof ServiceError) || err.status !== 401) return null;
  const details = (err.body as { details?: { field?: unknown; message?: unknown }[] } | null)?.details;
  const otp = Array.isArray(details) ? details.find((d) => d && d.field === 'otp') : undefined;
  if (!otp) return null;
  return otp.message === 'is required' ? 'required' : 'invalid';
}
