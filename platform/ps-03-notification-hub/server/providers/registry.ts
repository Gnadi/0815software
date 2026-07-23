import { consoleProvider } from './console.js';
import { resendProvider } from './resend-email.js';
import { webhookProvider } from './webhook.js';
import { defaultFetch, type FetchLike, type ProviderResolver } from './index.js';

/**
 * Build the provider resolver from configuration. The key behaviour is
 * graceful degradation: a channel whose real provider is not configured
 * (e.g. an email channel with no RESEND_API_KEY) falls back to the console
 * no-op provider, so a send still succeeds without any external call.
 */
export function buildResolver(opts: {
  resendApiKey?: string | null;
  fetchImpl?: FetchLike;
}): ProviderResolver {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  return (channel) => {
    switch (channel.provider) {
      case 'resend-email':
        return opts.resendApiKey ? resendProvider(opts.resendApiKey, fetchImpl) : consoleProvider;
      case 'webhook':
        return webhookProvider(fetchImpl);
      case 'console':
      default:
        // sms / slack / teams / discord ship console-backed stubs in v1.
        return consoleProvider;
    }
  };
}
