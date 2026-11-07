import { BaseClient } from './http.js';
import type { Message, SendMessageInput } from './types.js';

/** How urgent an event is: interrupt now, wait for the next digest, or only count. */
export type NotifyUrgency = 'now' | 'digest' | 'badge';

/**
 * Something that happened which a PERSON may need to act on — PS-03 decides
 * whether, when and on which device they hear of it (docs/NOTIFICATIONS-PLAN.md).
 * `title` shows on a lock screen and must name no person, amount or customer;
 * those go in `detail`, which the person sees once they open it (or on the lock
 * screen if they chose that).
 */
export interface NotifyEventInput {
  /** The module's registry slug — the app opens `href` in this module. */
  module: string;
  kind: string;
  category: string;
  urgency: NotifyUrgency;
  recipients: string[];
  /** Who caused it; never notified about their own action. */
  actor?: string | null;
  title: string;
  detail?: string | null;
  href?: string | null;
  /** Through quiet hours (stand-by duty). */
  oncall?: boolean;
  /** Through quiet hours and mutes (sign-in and account events). */
  security?: boolean;
  /** Same key + same person = the same notification, however often sent. */
  idempotency_key: string;
}

export interface NotifyPrefs {
  timezone: string;
  workdays: number[];
  briefing: { enabled: boolean; at: string };
  wrapup: { enabled: boolean; at: string };
  quiet: { from: string; to: string } | null;
  digest_via: 'push' | 'email' | 'both';
  lock_screen_details: boolean;
  muted: string[];
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificationEntry {
  id: number;
  module: string;
  kind: string;
  category: string;
  urgency: NotifyUrgency;
  title: string;
  detail: string | null;
  href: string | null;
  state: string;
  created_at: string;
  delivered_at: string | null;
}

/** Client for PS-03 Notification Hub (default port 4003). */
export class NotificationClient extends BaseClient {
  /** Enqueue a message (service-token auth). Rendered at enqueue, delivered on tick. */
  send(input: SendMessageInput): Promise<{ message: Message }> {
    return this.apiPost('/api/send', input);
  }

  getMessage(id: string | number): Promise<{ message: Message; events: unknown[] }> {
    return this.apiGet(`/api/messages/${encodeURIComponent(String(id))}`);
  }

  /** Report an event for people (service token). */
  event(input: NotifyEventInput): Promise<{ recorded: number; skipped: number }> {
    return this.apiPost('/api/events', input);
  }

  publicKey(): Promise<{ public_key: string | null }> {
    return this.apiGet('/api/push/public-key');
  }

  subscribe(recipient: string, subscription: PushSubscriptionInput, device: string | null): Promise<{ device: unknown }> {
    return this.apiPost('/api/push/subscriptions', { recipient, subscription, device });
  }

  devices(recipient: string): Promise<{ devices: { id: number; device: string | null; created_at: string; last_sent_at: string | null }[] }> {
    return this.apiGet(`/api/push/subscriptions?recipient=${encodeURIComponent(recipient)}`);
  }

  /**
   * One device by endpoint or id; or every device of the person when neither
   * is given, but for `except_endpoint` (the device asking).
   */
  unsubscribe(recipient: string, which: { endpoint?: string; id?: number; except_endpoint?: string } = {}): Promise<{ removed: number }> {
    return this.apiPost('/api/push/subscriptions/remove', { recipient, ...which });
  }

  prefs(recipient: string): Promise<{ prefs: NotifyPrefs; overrides: Partial<NotifyPrefs>; defaults: NotifyPrefs }> {
    return this.apiGet(`/api/prefs?recipient=${encodeURIComponent(recipient)}`);
  }

  setPrefs(recipient: string, prefs: Partial<NotifyPrefs>): Promise<{ prefs: NotifyPrefs }> {
    return this.apiPut('/api/prefs', { recipient, prefs });
  }

  settings(): Promise<{ defaults: NotifyPrefs; email_channel: string }> {
    return this.apiGet('/api/notify/settings');
  }

  setSettings(input: { defaults?: Partial<NotifyPrefs>; email_channel?: string }): Promise<{ defaults: NotifyPrefs; email_channel: string }> {
    return this.apiPut('/api/notify/settings', input);
  }

  notifications(recipient: string): Promise<{ notifications: NotificationEntry[] }> {
    return this.apiGet(`/api/notifications?recipient=${encodeURIComponent(recipient)}`);
  }
}
