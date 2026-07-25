import type { FetchLike, OutboundMessage, Provider, SendOutcome } from './index.js';

/**
 * Microsoft Teams incoming-webhook provider: a single `fetch` posting a
 * minimal MessageCard to the channel's configured `url`. Selected only when
 * the channel carries a webhook url; otherwise falls back to console.
 */
export function teamsProvider(fetchImpl: FetchLike): Provider {
  return {
    name: 'teams',
    async send(msg: OutboundMessage): Promise<SendOutcome> {
      const url = typeof msg.config.url === 'string' ? msg.config.url : '';
      if (!url) return { ok: false, error: 'channel has no teams webhook url configured' };
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            '@type': 'MessageCard',
            '@context': 'https://schema.org/extensions',
            title: msg.subject ?? undefined,
            text: msg.body,
          }),
        });
        return res.ok ? { ok: true, providerMessageId: `teams-${res.status}` } : { ok: false, error: `Teams HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
