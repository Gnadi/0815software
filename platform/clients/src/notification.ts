import { BaseClient } from './http.js';
import type { Message, SendMessageInput } from './types.js';

/** Client for PS-03 Notification Hub (default port 4003). */
export class NotificationClient extends BaseClient {
  /** Enqueue a message (service-token auth). Rendered at enqueue, delivered on tick. */
  send(input: SendMessageInput): Promise<Message> {
    return this.apiPost<Message>('/api/send', input);
  }

  getMessage(id: string): Promise<Message & { events: unknown[] }> {
    return this.apiGet(`/api/messages/${encodeURIComponent(id)}`);
  }
}
