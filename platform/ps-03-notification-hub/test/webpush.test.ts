import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  b64url,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  isAllowedPushEndpoint,
  DEFAULT_PUSH_HOSTS,
  sendPush,
  vapidAuthorization,
  vapidPublicKey,
} from '../server/webpush.js';

// RFC 8291 Appendix A — every value copied from the RFC, not produced here.
const A = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('RFC 8291 Appendix A', () => {
  const { body, trace } = encryptPayload(
    Buffer.from(A.plaintext),
    { p256dh: A.uaPublic, auth: A.auth },
    { ephemeralPrivate: fromB64url(A.asPrivate), salt: fromB64url(A.salt) },
  );

  it('derives the same intermediate values', () => {
    expect(b64url(trace.ecdhSecret)).toBe(A.ecdhSecret);
    expect(b64url(trace.ikm)).toBe(A.ikm);
    expect(b64url(trace.prk)).toBe(A.prk);
    expect(b64url(trace.cek)).toBe(A.cek);
    expect(b64url(trace.nonce)).toBe(A.nonce);
  });

  it('produces the same encrypted message, byte for byte', () => {
    expect(b64url(body)).toBe(A.body);
    // The ephemeral public key in the header is the RFC's.
    expect(b64url(body.subarray(21, 86))).toBe(A.asPublic);
  });

  it('never reuses salt or key when not told to', () => {
    const one = encryptPayload(Buffer.from('x'), { p256dh: A.uaPublic, auth: A.auth }).body;
    const two = encryptPayload(Buffer.from('x'), { p256dh: A.uaPublic, auth: A.auth }).body;
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
  });

  it('refuses a malformed subscription key', () => {
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: A.auth, auth: A.auth })).toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  const keys = generateVapidKeys();

  it('derives the public key from the private one', () => {
    expect(vapidPublicKey(keys.privateKey)).toBe(keys.publicKey);
    expect(fromB64url(keys.publicKey)).toHaveLength(65);
  });

  it('signs an ES256 JWT for the push service origin that the public key verifies', () => {
    const now = Date.parse('2026-11-07T09:00:00Z');
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { privateKey: keys.privateKey, subject: 'mailto:ops@example.test' }, now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(fromB64url(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(fromB64url(c!).toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:ops@example.test' });
    const pub = fromB64url(keys.publicKey);
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(s!))).toBe(true);
  });
});

describe('delivery', () => {
  const keys = generateVapidKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', p256dh: A.uaPublic, auth: A.auth };
  const opts = (status: number, seen: unknown[]) => ({
    vapid: { privateKey: keys.privateKey, subject: 'mailto:ops@example.test' },
    urgency: 'high' as const,
    ttlSeconds: 3600,
    topic: 'mod-12:ticket/7',
    now: Date.now(),
    fetch: async (url: string, init: unknown) => {
      seen.push({ url, init });
      return { status };
    },
  });

  it('posts aes128gcm with the RFC 8030 headers', async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: Uint8Array } }[] = [];
    expect((await sendPush(sub, { title: 'x' }, opts(201, seen))).outcome).toBe('sent');
    const { headers, body } = seen[0]!.init;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('3600');
    expect(headers.Urgency).toBe('high');
    expect(headers.Topic).toBe('mod-12ticket7');
    expect(headers.Authorization.startsWith('vapid t=')).toBe(true);
    expect(Buffer.from(body).readUInt32BE(16)).toBe(4096);
  });

  it('reports a dropped subscription as gone, other failures as failed', async () => {
    expect((await sendPush(sub, {}, opts(410, []))).outcome).toBe('gone');
    expect((await sendPush(sub, {}, opts(404, []))).outcome).toBe('gone');
    expect((await sendPush(sub, {}, opts(500, []))).outcome).toBe('failed');
  });

  it('accepts only the browsers’ push services as endpoints', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/1', DEFAULT_PUSH_HOSTS)).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc', DEFAULT_PUSH_HOSTS)).toBe(true);
    expect(isAllowedPushEndpoint('https://db5p.notify.windows.com/w/?token=1', DEFAULT_PUSH_HOSTS)).toBe(true);
    expect(isAllowedPushEndpoint('https://notify.windows.com.evil.test/', DEFAULT_PUSH_HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/fcm/send/1', DEFAULT_PUSH_HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x', DEFAULT_PUSH_HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest', DEFAULT_PUSH_HOSTS)).toBe(false);
    expect(isAllowedPushEndpoint('not a url', DEFAULT_PUSH_HOSTS)).toBe(false);
  });
});
