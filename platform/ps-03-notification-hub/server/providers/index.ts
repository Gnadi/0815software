import type { ChannelType } from '../../shared/types.js';

/** What a provider is handed to actually deliver. */
export interface OutboundMessage {
  channelType: ChannelType;
  to: string;
  subject: string | null;
  body: string;
  config: Record<string, unknown>;
}

export interface SendOutcome {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface Provider {
  name: string;
  send(msg: OutboundMessage): Promise<SendOutcome>;
}

/** A minimal, injectable HTTP client so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

/** Resolves the concrete provider for a channel. */
export type ProviderResolver = (channel: { provider: string; config: Record<string, unknown> }) => Provider;
