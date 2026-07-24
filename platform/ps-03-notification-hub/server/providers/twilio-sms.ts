import type { FetchLike, OutboundMessage, Provider, SendOutcome } from './index.js';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Default sender; a channel may override via config.from. */
  from?: string;
}

/**
 * Twilio SMS provider: a single form-encoded `fetch` to the Messages API
 * with HTTP Basic auth, no SDK. Selected only when Twilio credentials are
 * configured; otherwise the resolver hands back the console provider.
 */
export function twilioSmsProvider(cfg: TwilioConfig, fetchImpl: FetchLike): Provider {
  return {
    name: 'twilio-sms',
    async send(msg: OutboundMessage): Promise<SendOutcome> {
      const from = typeof msg.config.from === 'string' ? msg.config.from : cfg.from ?? '';
      if (!from) return { ok: false, error: 'no Twilio sender (from) configured' };
      const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
      const body = new URLSearchParams({ To: msg.to, From: from, Body: msg.body }).toString();
      try {
        const res = await fetchImpl(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${auth}` },
            body,
          },
        );
        return res.ok
          ? { ok: true, providerMessageId: `twilio-${res.status}` }
          : { ok: false, error: `Twilio HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
