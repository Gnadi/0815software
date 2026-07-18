import { createHmac } from 'node:crypto';
import { safeEqual } from './auth.js';

/**
 * Signed guest tokens — the public face of the shop is authenticated by
 * HMAC signatures instead of accounts:
 *
 *  - The anonymous cart cookie (`mod07_cart`) holds "<cartId>.<hmac>".
 *    A guest can only ever address the cart id they were handed; a
 *    tampered id fails verification and is treated as "no cart".
 *
 *  - The order lookup token is hmac("order.<ref>") handed out exactly
 *    once, on the confirmation page. Anyone with the link can check the
 *    order status; anyone without it gets a 404 — even for a real ref,
 *    so refs leak nothing.
 *
 * Both are stateless: nothing to store, nothing to expire, and they use
 * the same SESSION_SECRET as the admin session (distinct HMAC payload
 * prefixes keep the three token kinds mutually unusable).
 */

export const CART_COOKIE = 'mod07_cart';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// ── Cart cookie ────────────────────────────────────────────────────────

export function signCartId(secret: string, cartId: number): string {
  return `${cartId}.${sign(`cart.${cartId}`, secret)}`;
}

/** Returns the cart id, or null for a missing/malformed/tampered token. */
export function verifyCartToken(secret: string, token: string | undefined): number | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(id)) return null;
  return safeEqual(mac, sign(`cart.${id}`, secret)) ? Number(id) : null;
}

const CART_TTL_DAYS = 30;

export function cartCookie(token: string, secure: boolean): string {
  const attrs = [
    `${CART_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${CART_TTL_DAYS * 86_400}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedCartCookie(): string {
  return `${CART_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ── Order lookup token ─────────────────────────────────────────────────

export function orderToken(secret: string, ref: string): string {
  return sign(`order.${ref}`, secret);
}

export function verifyOrderToken(secret: string, ref: string, token: unknown): boolean {
  return typeof token === 'string' && token !== '' && safeEqual(token, orderToken(secret, ref));
}
