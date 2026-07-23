/**
 * PS-03 Notification Hub — wire contract shared between server and client.
 */

export const CHANNEL_TYPES = ['email', 'sms', 'push', 'slack', 'teams', 'discord', 'webhook'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const MESSAGE_STATUSES = ['queued', 'sent', 'failed', 'dead'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export function isChannelType(v: string): v is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(v);
}

export interface Channel {
  id: number;
  type: ChannelType;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export interface Template {
  id: number;
  key: string;
  version: number;
  channel_type: ChannelType;
  locale: string;
  subject: string | null;
  body: string;
  created_at: string;
}

export interface RenderedMessage {
  subject: string | null;
  body: string;
}

export interface Message {
  id: number;
  channel_id: number;
  template_key: string | null;
  to_address: string;
  subject: string | null;
  body: string;
  status: MessageStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface SendRequest {
  channel: string;
  to: string;
  template_key?: string;
  variables?: Record<string, unknown>;
  subject?: string;
  body?: string;
  idempotency_key?: string;
}

export interface FieldError {
  field: string;
  message: string;
}
