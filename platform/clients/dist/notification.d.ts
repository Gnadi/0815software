import { BaseClient } from './http.js';
import type { Message, SendMessageInput } from './types.js';
/** Client for PS-03 Notification Hub (default port 4003). */
export declare class NotificationClient extends BaseClient {
    /** Enqueue a message (service-token auth). Rendered at enqueue, delivered on tick. */
    send(input: SendMessageInput): Promise<Message>;
    getMessage(id: string): Promise<Message & {
        events: unknown[];
    }>;
}
