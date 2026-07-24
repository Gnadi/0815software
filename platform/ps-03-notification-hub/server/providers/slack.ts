import type { FetchLike, OutboundMessage, Provider, SendOutcome } from './index.js';

/**
 * Slack incoming-webhook provider: a single `fetch` to the channel's
 * configured `url`, no SDK. Selected only when the channel carries a
 * webhook url; otherwise the resolver hands back the console provider.
 */
export function slackProvider(fetchImpl: FetchLike): Provider {
  return {
    name: 'slack',
    async send(msg: OutboundMessage): Promise<SendOutcome> {
      const url = typeof msg.config.url === 'string' ? msg.config.url : '';
      if (!url) return { ok: false, error: 'channel has no slack webhook url configured' };
      const text = msg.subject ? `*${msg.subject}*\n${msg.body}` : msg.body;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        return res.ok ? { ok: true, providerMessageId: `slack-${res.status}` } : { ok: false, error: `Slack HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
