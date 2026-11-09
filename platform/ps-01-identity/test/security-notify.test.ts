import { describe, expect, it } from 'vitest';
import { buildSecurityNotifier, noopSecurityNotifier } from '../server/security-notify.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('security notifier', () => {
  it('makes no call at all without NOTIFICATION_URL', () => {
    expect(buildSecurityNotifier(null)).toBe(noopSecurityNotifier);
  });

  it('posts a security event to PS-03 with the service token', async () => {
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const notify = buildSecurityNotifier({ url: 'http://ps03:4003/', serviceToken: 'tok' }, async (url, init) => {
      calls.push({ url, init });
      return {};
    });
    notify({ kind: 'mfa-disabled', email: 'ada@acme.test', detail: null, key: '7:1' });
    await flush();
    expect(calls[0]!.url).toBe('http://ps03:4003/api/events');
    expect(calls[0]!.init.headers['X-Service-Token']).toBe('tok');
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({
      module: 'identity',
      kind: 'mfa-disabled',
      category: 'security',
      urgency: 'now',
      security: true,
      recipients: ['ada@acme.test'],
      idempotency_key: 'identity:mfa-disabled:7:1',
    });
  });

  it('never throws into the sign-in when PS-03 is down', async () => {
    const notify = buildSecurityNotifier({ url: 'http://ps03:4003', serviceToken: 'tok' }, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(() => notify({ kind: 'new-device', email: 'a@b.c', detail: null, key: 'k' })).not.toThrow();
    await flush();
  });
});
