import { BaseClient, ServiceError } from './http.js';
import type { LoginResult, TokenVerdict } from './types.js';

/** Client for PS-01 Identity (default port 4001). */
export class IdentityClient extends BaseClient {
  /**
   * Authenticate an end user; returns a PS-01 session token. `otp` is the
   * second factor — a six-digit code or a recovery code — for an account that
   * has one or must set one up; see `secondFactorRefusal`. `device` is what
   * the browser said about itself, so PS-01 can tell the person about a
   * sign-in from a device it has not seen before.
   */
  login(
    orgSlug: string,
    email: string,
    password: string,
    otp?: string,
    device?: { user_agent?: string; ip?: string },
  ): Promise<LoginResult> {
    return this.apiPost<LoginResult>('/api/login', {
      org_slug: orgSlug,
      email,
      password,
      ...(otp ? { otp } : {}),
      ...(device ? { device } : {}),
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

  // ── The person's own account (identity token) ──────────────────────
  // What a shell's account page does on the person's behalf, with their own
  // PS-01 token — PS-01 decides, the shell only carries the request.

  account(): Promise<{ user: IdentityUser; organization: { mfa_required: boolean; name: string }; permissions: string[] }> {
    return this.apiGet('/api/me');
  }

  mfaStatus(): Promise<{ totp_enabled: boolean; enabled_at: string | null; recovery_codes_left: number }> {
    return this.apiGet('/api/me/mfa');
  }

  mfaSetup(currentPassword: string): Promise<{ secret: string; otpauth_uri: string; expires_in_s: number }> {
    return this.apiPost('/api/me/mfa/totp/setup', { current_password: currentPassword });
  }

  /** Switching the factor on ends every other session; `token` is this caller's fresh one. */
  mfaConfirm(otp: string): Promise<{ totp_enabled: true; recovery_codes: string[]; token: string }> {
    return this.apiPost('/api/me/mfa/totp/confirm', { otp });
  }

  mfaDisable(currentPassword: string, otp: string): Promise<{ totp_enabled: false }> {
    return this.apiPost('/api/me/mfa/totp/disable', { current_password: currentPassword, otp });
  }

  renewRecoveryCodes(currentPassword: string, otp: string): Promise<{ recovery_codes: string[] }> {
    return this.apiPost('/api/me/mfa/recovery-codes', { current_password: currentPassword, otp });
  }

  changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    return this.apiPost(`/api/users/${userId}/password`, { current_password: currentPassword, new_password: newPassword });
  }

  revokeMySessions(): Promise<{ revoked: true; token: string | null }> {
    return this.apiPost('/api/me/sessions/revoke');
  }

  // ── Administration (the caller's PS-01 permissions decide) ────────

  users(): Promise<{ users: IdentityUser[] }> {
    return this.apiGet('/api/users');
  }

  resetUserMfa(userId: number): Promise<{ user: IdentityUser }> {
    return this.apiPost(`/api/users/${userId}/mfa/reset`);
  }

  revokeUserSessions(userId: number): Promise<{ revoked: true }> {
    return this.apiPost(`/api/users/${userId}/sessions/revoke`);
  }

  setMfaRequired(required: boolean): Promise<{ organization: { mfa_required: boolean } }> {
    return this.apiPatch('/api/orgs/current', { mfa_required: required });
  }

  /**
   * Who holds `permission` in the organization (service token): the emails a
   * module notifies when something waits for "whoever may approve here".
   */
  holders(orgSlug: string, permission: string): Promise<{ holders: string[] }> {
    return this.apiGet(`/api/directory/holders?org_slug=${encodeURIComponent(orgSlug)}&permission=${encodeURIComponent(permission)}`);
  }
}

export interface IdentityUser {
  id: number;
  org_id: number;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  mfa_enabled: boolean;
  created_at: string;
}

/**
 * Whether a refused PS-01 login was about the SECOND factor, and which way:
 * `required` — the password was right and the account wants a code (show the
 * code field); `setup` — the organization requires a factor this person has
 * not set up, and `secondFactorSetup` carries the QR code's content; `invalid`
 * — the code was wrong. Anything else is `null`, and the caller treats it as
 * it always did. Read from the error's field details, not its wording.
 */
export function secondFactorRefusal(err: unknown): 'required' | 'setup' | 'invalid' | null {
  if (!(err instanceof ServiceError) || err.status !== 401) return null;
  const details = (err.body as { details?: { field?: unknown; message?: unknown }[] } | null)?.details;
  const otp = Array.isArray(details) ? details.find((d) => d && d.field === 'otp') : undefined;
  if (!otp) return null;
  if (otp.message === 'is required') return 'required';
  if (otp.message === 'must be set up') return 'setup';
  return 'invalid';
}

/** The secret and otpauth URI of a pending enrolment, when PS-01 sent one. */
export function secondFactorSetup(err: unknown): { secret: string; otpauth_uri: string } | null {
  if (!(err instanceof ServiceError)) return null;
  const setup = (err.body as { mfa_setup?: { secret?: unknown; otpauth_uri?: unknown } } | null)?.mfa_setup;
  return setup && typeof setup.secret === 'string' && typeof setup.otpauth_uri === 'string'
    ? { secret: setup.secret, otpauth_uri: setup.otpauth_uri }
    : null;
}
