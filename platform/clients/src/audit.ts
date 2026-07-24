import { BaseClient } from './http.js';
import type { AuditEvent, AuditEventInput } from './types.js';

/** Client for PS-07 Audit Log (default port 4007). */
export class AuditClient extends BaseClient {
  /** Append a tamper-evident audit event (service-token auth). */
  record(event: AuditEventInput): Promise<AuditEvent> {
    return this.apiPost<AuditEvent>('/api/events', event);
  }

  list(filter?: { actor?: string; resource?: string; action?: string; since?: string; limit?: number }): Promise<{ events: AuditEvent[] }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter ?? {})) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.apiGet(`/api/events${suffix}`);
  }

  /** Verify the hash chain is intact. */
  verify(): Promise<{ valid: boolean; count: number; broken_at?: number }> {
    return this.apiGet('/api/verify');
  }
}
