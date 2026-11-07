import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

/**
 * Web Push, on Node's crypto alone:
 *
 *  - **RFC 8291** — message encryption. The browser hands over a P-256 public
 *    key and a 16-byte auth secret when it subscribes; every message is
 *    encrypted to that key with a fresh ephemeral key pair, so the push
 *    service in between (Google, Mozilla, Apple) carries ciphertext it cannot
 *    read. Content coding `aes128gcm` from RFC 8188, one record.
 *  - **RFC 8292** — VAPID. The push service accepts a message only with a
 *    JWT signed (ES256) by the key the subscription was created for; that key
 *    pair belongs to this stack (`VAPID_PRIVATE_KEY`).
 *
 * Pinned to the RFC 8291 Appendix A vector, intermediate values included
 * (`test/webpush.test.ts`). Written here rather than pulled in, for the same
 * reason TOTP is in PS-01: it is a handful of HMACs, one ECDH and one AES-GCM,
 * and the evidence that it is right is the RFC's own example, not a package.
 */

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Single-block HKDF-Expand: every length RFC 8291 needs is ≤ 32 bytes. */
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

export interface Subscription {
  endpoint: string;
  /** The browser's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** 16 random bytes from the browser, base64url. */
  auth: string;
}

export interface EncryptionTrace {
  ecdhSecret: Buffer;
  ikm: Buffer;
  prk: Buffer;
  cek: Buffer;
  nonce: Buffer;
}

/** Record size written into the header; one record carries the whole message. */
const RECORD_SIZE = 4096;

/**
 * Encrypt a payload for one subscription (RFC 8291 §3.4, RFC 8188 §2).
 * `ephemeralPrivate` and `salt` are injectable only so the RFC vector can be
 * reproduced; in use both are fresh per message, and reusing either would
 * reuse the content key.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: Pick<Subscription, 'p256dh' | 'auth'>,
  opts: { ephemeralPrivate?: Buffer; salt?: Buffer } = {},
): { body: Buffer; trace: EncryptionTrace } {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  // 4096 minus header and tag, minus the delimiter: what one record can hold.
  if (plaintext.length > RECORD_SIZE - 16 - 1 - 86) throw new Error('payload too large for one record');

  const ecdh = createECDH('prime256v1');
  if (opts.ephemeralPrivate) ecdh.setPrivateKey(opts.ephemeralPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // §3.3: the auth secret and both public keys go into the input keying material.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);

  const salt = opts.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the padding delimiter of the last (here: only) record.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return { body: Buffer.concat([header, asPublic, ciphertext, tag]), trace: { ecdhSecret, ikm, prk, cek, nonce } };
}

// ── VAPID (RFC 8292) ───────────────────────────────────────────────────

export interface VapidKeys {
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
  /** The uncompressed public point, base64url — what browsers subscribe with. */
  publicKey: string;
}

/** A fresh key pair for a new stack (`deploy/provision.mjs` mints one). */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: b64url(ecdh.getPrivateKey()), publicKey: b64url(ecdh.getPublicKey()) };
}

/** Derive the public key from the private one, so only one secret is configured. */
export function vapidPublicKey(privateKey: string): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(privateKey));
  return b64url(ecdh.getPublicKey());
}

function signingKey(privateKey: string) {
  const pub = fromB64url(vapidPublicKey(privateKey));
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/**
 * The `Authorization` header for one push request. The audience is the push
 * service's origin, and the token lives 12 hours — RFC 8292 caps it at 24,
 * and a shorter life limits what a leaked request log is worth.
 */
export function vapidAuthorization(endpoint: string, keys: { privateKey: string; subject: string }, nowMs: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject }),
    ),
  );
  const input = `${header}.${claims}`;
  // JOSE wants the raw r||s form, not DER.
  const signature = sign('sha256', Buffer.from(input), { key: signingKey(keys.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64url(signature)}, k=${vapidPublicKey(keys.privateKey)}`;
}

// ── Delivery ───────────────────────────────────────────────────────────

export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array },
) => Promise<{ status: number }>;

export const defaultPushFetch: PushFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
};

/**
 * What became of one push. `gone` means the browser dropped the subscription
 * (404/410 from the push service) and the row should go; anything else that
 * is not 2xx is a transient failure worth another try later.
 */
export type PushOutcome = 'sent' | 'gone' | 'failed';

export async function sendPush(
  sub: Subscription,
  payload: unknown,
  opts: {
    vapid: { privateKey: string; subject: string };
    urgency: 'very-low' | 'low' | 'normal' | 'high';
    ttlSeconds: number;
    /** Replaces an earlier, undelivered push with the same topic (RFC 8030 §5.4). */
    topic?: string;
    fetch?: PushFetch;
    now: number;
  },
): Promise<{ outcome: PushOutcome; status: number | null }> {
  const { body } = encryptPayload(Buffer.from(JSON.stringify(payload)), sub);
  const headers: Record<string, string> = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttlSeconds),
    Urgency: opts.urgency,
    Authorization: vapidAuthorization(sub.endpoint, opts.vapid, opts.now),
  };
  // Topics are at most 32 base64url characters.
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const res = await (opts.fetch ?? defaultPushFetch)(sub.endpoint, { method: 'POST', headers, body });
    if (res.status >= 200 && res.status < 300) return { outcome: 'sent', status: res.status };
    if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status };
    return { outcome: 'failed', status: res.status };
  } catch {
    return { outcome: 'failed', status: null };
  }
}

/**
 * Push services a subscription may point at. The endpoint arrives from a
 * browser — that is, from whoever is signed in — so without this list it is a
 * way to make this service POST to any address, internal ones included. These
 * are the services the major browsers use; `PUSH_ALLOWED_HOSTS` adds more.
 */
export const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  '*.notify.windows.com',
];

export function isAllowedPushEndpoint(endpoint: string, allowed: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return allowed.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
  );
}
