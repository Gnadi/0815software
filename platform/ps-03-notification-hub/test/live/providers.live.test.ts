import { describe, expect, it } from 'vitest';

/**
 * Gated live suite (see `npm run test:live`) — hits the REAL Resend / Twilio
 * APIs to validate credentials, so each case skips unless its key env is set.
 * Running these is the remaining, user-supplied step for the A5 vendor path.
 */
const RESEND = process.env.LIVE_RESEND_KEY;
const TWILIO_SID = process.env.LIVE_TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.LIVE_TWILIO_AUTH_TOKEN;

describe.skipIf(!RESEND)('PS-03 · live Resend', () => {
  it('authenticates against the Resend API', async () => {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { authorization: `Bearer ${RESEND}` },
    });
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!(TWILIO_SID && TWILIO_TOKEN))('PS-03 · live Twilio', () => {
  it('authenticates against the Twilio API', async () => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}.json`, {
      headers: { authorization: `Basic ${auth}` },
    });
    expect(res.status).toBe(200);
  });
});
