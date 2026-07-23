import { randomBytes } from 'node:crypto';
import type { OutboundMessage, Provider, SendOutcome } from './index.js';

/**
 * The default no-op provider. It "delivers" by accepting the message and
 * returning a synthetic id — zero external calls. Every channel degrades
 * to this when its real provider is not configured, mirroring the
 * graceful degradation of the marketing site's contact form.
 */
export const consoleProvider: Provider = {
  name: 'console',
  async send(_msg: OutboundMessage): Promise<SendOutcome> {
    return { ok: true, providerMessageId: `console-${randomBytes(8).toString('hex')}` };
  },
};
