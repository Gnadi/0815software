import type { FetchLike, OutboundMessage, Provider, SendOutcome } from './index.js';

/** Delivers a message by POSTing it to the channel's configured URL. */
export function webhookProvider(fetchImpl: FetchLike): Provider {
  return {
    name: 'webhook',
    async send(msg: OutboundMessage): Promise<SendOutcome> {
      const url = typeof msg.config.url === 'string' ? msg.config.url : '';
      if (!url) return { ok: false, error: 'channel has no webhook url configured' };
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: msg.to, subject: msg.subject, body: msg.body }),
        });
        return res.ok ? { ok: true, providerMessageId: `webhook-${res.status}` } : { ok: false, error: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
