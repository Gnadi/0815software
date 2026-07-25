import { describe, expect, it } from 'vitest';

/**
 * Gated live suite (see `npm run test:live`) — hits the REAL OpenAI / Anthropic
 * APIs, so each case skips unless its key env is set. Running these is the
 * remaining, user-supplied step for the A5 vendor path.
 */
const OPENAI = process.env.LIVE_OPENAI_KEY;
const ANTHROPIC = process.env.LIVE_ANTHROPIC_KEY;

describe.skipIf(!OPENAI)('PS-04 · live OpenAI', () => {
  it('lists models with the configured key', async () => {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${OPENAI}` },
    });
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!ANTHROPIC)('PS-04 · live Anthropic', () => {
  it('completes a one-token message', async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res.ok).toBe(true);
  });
});
