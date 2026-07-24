import { BaseClient } from './http.js';
/** Client for PS-03 Notification Hub (default port 4003). */
export class NotificationClient extends BaseClient {
    /** Enqueue a message (service-token auth). Rendered at enqueue, delivered on tick. */
    send(input) {
        return this.apiPost('/api/send', input);
    }
    getMessage(id) {
        return this.apiGet(`/api/messages/${encodeURIComponent(id)}`);
    }
}
