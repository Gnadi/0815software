import { BaseClient } from './http.js';
/** Client for PS-01 Identity (default port 4001). */
export class IdentityClient extends BaseClient {
    /** Authenticate an end user; returns a PS-01 session token. */
    login(orgSlug, email, password) {
        return this.apiPost('/api/login', { org_slug: orgSlug, email, password });
    }
    /** The cross-service contract: validate a session token and return its claims. */
    verify(token) {
        return this.apiPost('/api/tokens/verify', { token });
    }
    /** Current principal (uses the forwarded identity token). */
    me() {
        return this.apiGet('/api/me');
    }
    listUsers() {
        return this.apiGet('/api/users');
    }
}
