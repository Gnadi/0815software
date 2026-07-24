import type { FetchLike, OutboundMessage, Provider, SendOutcome } from './index.js';

/**
 * Discord webhook provider: a single `fetch` posting `content` to the
 * channel's configured `url`. Selected only when the channel carries a
 * webhook url; otherwise falls back to console. Discord caps content at
 * 2000 characters, so the body is truncated to fit.
 */
export function discordProvider(fetchImpl: FetchLike): Provider {
  return {
    name: 'discord',
    async send(msg: OutboundMessage): Promise<SendOutcome> {
      const url = typeof msg.config.url === 'string' ? msg.config.url : '';
      if (!url) return { ok: false, error: 'channel has no discord webhook url configured' };
      const full = msg.subject ? `**${msg.subject}**\n${msg.body}` : msg.body;
      const content = full.length > 2000 ? `${full.slice(0, 1997)}...` : full;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        return res.ok ? { ok: true, providerMessageId: `discord-${res.status}` } : { ok: false, error: `Discord HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
