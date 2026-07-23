import type { FetchLike, OutboundMessage, Provider, SendOutcome } from './index.js';

/**
 * Real email provider, modelled on the marketing site's contact form:
 * a single `fetch` to the Resend API, no SDK. It is only ever selected
 * when RESEND_API_KEY is present — otherwise the resolver hands back the
 * console provider instead.
 */
export function resendProvider(apiKey: string, fetchImpl: FetchLike): Provider {
  return {
    name: 'resend-email',
    async send(msg: OutboundMessage): Promise<SendOutcome> {
      const from = typeof msg.config.from === 'string' ? msg.config.from : 'notifications@example.com';
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ from, to: msg.to, subject: msg.subject ?? '', html: msg.body }),
        });
        return res.ok
          ? { ok: true, providerMessageId: `resend-${res.status}` }
          : { ok: false, error: `Resend HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
