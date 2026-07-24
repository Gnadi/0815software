import { BaseClient } from './http.js';
/** Client for PS-05 Integration Hub (default port 4005). */
export class IntegrationClient extends BaseClient {
    listConnections() {
        return this.apiGet('/api/connections');
    }
    /** Issue a REST call through a stored connection; credentials never leave the hub. */
    proxy(connectionId, input) {
        return this.apiPost(`/api/connections/${connectionId}/proxy`, input);
    }
    graphql(connectionId, query, variables) {
        return this.apiPost(`/api/connections/${connectionId}/graphql`, { query, variables });
    }
    /** Enqueue a sync job; the worker pulls on the hub's tick. */
    sync(connectionId, kind) {
        return this.apiPost(`/api/connections/${connectionId}/sync`, { kind });
    }
}
