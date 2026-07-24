import { BaseClient } from './http.js';
import type { LoginResult, TokenVerdict } from './types.js';

/** Client for PS-01 Identity (default port 4001). */
export class IdentityClient extends BaseClient {
  /** Authenticate an end user; returns a PS-01 session token. */
  login(orgSlug: string, email: string, password: string): Promise<LoginResult> {
    return this.apiPost<LoginResult>('/api/login', { org_slug: orgSlug, email, password });
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
