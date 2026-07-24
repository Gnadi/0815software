import { consoleProvider } from './console.js';
import { resendProvider } from './resend-email.js';
import { webhookProvider } from './webhook.js';
import { slackProvider } from './slack.js';
import { teamsProvider } from './teams.js';
import { discordProvider } from './discord.js';
import { twilioSmsProvider, type TwilioConfig } from './twilio-sms.js';
import { defaultFetch, type FetchLike, type ProviderResolver } from './index.js';

/**
 * Build the provider resolver from configuration. The key behaviour is
 * graceful degradation: a channel whose real provider is not configured
 * (e.g. an email channel with no RESEND_API_KEY, or a slack channel with no
 * webhook url) falls back to the console no-op provider, so a send still
 * succeeds without any external call.
 */
export function buildResolver(opts: {
  resendApiKey?: string | null;
  twilio?: TwilioConfig | null;
  fetchImpl?: FetchLike;
}): ProviderResolver {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const hasUrl = (config: Record<string, unknown>): boolean =>
    typeof config.url === 'string' && config.url.length > 0;

  return (channel) => {
    switch (channel.provider) {
      case 'resend-email':
        return opts.resendApiKey ? resendProvider(opts.resendApiKey, fetchImpl) : consoleProvider;
      case 'webhook':
        return webhookProvider(fetchImpl);
      case 'twilio-sms':
        return opts.twilio ? twilioSmsProvider(opts.twilio, fetchImpl) : consoleProvider;
      case 'slack':
        return hasUrl(channel.config) ? slackProvider(fetchImpl) : consoleProvider;
      case 'teams':
        return hasUrl(channel.config) ? teamsProvider(fetchImpl) : consoleProvider;
      case 'discord':
        return hasUrl(channel.config) ? discordProvider(fetchImpl) : consoleProvider;
      case 'console':
      default:
        return consoleProvider;
    }
  };
}
