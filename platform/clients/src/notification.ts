import { BaseClient, type RequestOptions } from './http.js';
import type { Message, SendMessageInput } from './types.js';

/** Client for PS-03 Notification Hub (default port 4003). */
export class NotificationClient extends BaseClient {
  /**
   * Enqueue a message (service-token auth). Rendered at enqueue, delivered on
   * tick. Pass an `idempotencyKey` in `opts` to make delivery safely
   * retryable so a duplicate submit never sends the notification twice.
   */
  send(input: SendMessageInput, opts?: RequestOptions): Promise<{ message: Message }> {
    return this.apiPost('/api/send', input, opts);
  }

  getMessage(id: string | number): Promise<{ message: Message; events: unknown[] }> {
    return this.apiGet(`/api/messages/${encodeURIComponent(String(id))}`);
  }
}
