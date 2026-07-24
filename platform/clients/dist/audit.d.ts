import { BaseClient } from './http.js';
import type { AuditEvent, AuditEventInput } from './types.js';
/** Client for PS-07 Audit Log (default port 4007). */
export declare class AuditClient extends BaseClient {
    /** Append a tamper-evident audit event (service-token auth). */
    record(event: AuditEventInput): Promise<AuditEvent>;
    list(filter?: {
        actor?: string;
        resource?: string;
        action?: string;
        since?: string;
        limit?: number;
    }): Promise<{
        events: AuditEvent[];
    }>;
    /** Verify the hash chain is intact. */
    verify(): Promise<{
        valid: boolean;
        count: number;
        broken_at?: number;
    }>;
}
