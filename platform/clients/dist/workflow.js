import { BaseClient } from './http.js';
/** Client for PS-02 Workflow Engine (default port 4002). */
export class WorkflowClient extends BaseClient {
    /** Ingest a domain event (service-token auth); may fan out to triggers. */
    emit(event) {
        return this.apiPost('/api/events', event);
    }
    /** Start a workflow instance directly; idempotent on `idempotency_key`. */
    run(key, input = {}) {
        return this.apiPost(`/api/workflows/${encodeURIComponent(key)}/run`, input);
    }
    getInstance(id) {
        return this.apiGet(`/api/instances/${encodeURIComponent(id)}`);
    }
    advance(id, step) {
        return this.apiPost(`/api/instances/${encodeURIComponent(id)}/advance`, { step });
    }
}
