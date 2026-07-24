import { describe, expect, it } from 'vitest';

/**
 * Gated live suite (see `npm run test:live`) — exercises a real upstream
 * through the same kind of token-authenticated call the connection proxy
 * makes, so it skips unless LIVE_GITHUB_TOKEN (a real PAT) is present. Running
 * it is the remaining, user-supplied step for the A5 vendor / OAuth path.
 */
const GH = process.env.LIVE_GITHUB_TOKEN;

describe.skipIf(!GH)('PS-05 · live GitHub connection', () => {
  it('authenticates against the GitHub API', async () => {
    const res = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${GH}`, 'user-agent': '0815software-platform' },
    });
    expect(res.status).toBe(200);
  });
});
