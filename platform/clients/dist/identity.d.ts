import { BaseClient } from './http.js';
import type { LoginResult, TokenVerdict } from './types.js';
/** Client for PS-01 Identity (default port 4001). */
export declare class IdentityClient extends BaseClient {
    /** Authenticate an end user; returns a PS-01 session token. */
    login(orgSlug: string, email: string, password: string): Promise<LoginResult>;
    /** The cross-service contract: validate a session token and return its claims. */
    verify(token: string): Promise<TokenVerdict>;
    /** Current principal (uses the forwarded identity token). */
    me(): Promise<{
        user: unknown;
        roles: unknown[];
        permissions: string[];
    }>;
    listUsers(): Promise<unknown[]>;
}
