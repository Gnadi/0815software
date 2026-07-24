import { BaseClient } from './http.js';
/** Client for PS-07 Audit Log (default port 4007). */
export class AuditClient extends BaseClient {
    /** Append a tamper-evident audit event (service-token auth). */
    record(event) {
        return this.apiPost('/api/events', event);
    }
    list(filter) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(filter ?? {})) {
            if (v !== undefined)
                qs.set(k, String(v));
        }
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        return this.apiGet(`/api/events${suffix}`);
    }
    /** Verify the hash chain is intact. */
    verify() {
        return this.apiGet('/api/verify');
    }
}
