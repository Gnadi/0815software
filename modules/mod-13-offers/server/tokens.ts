import { createHmac } from 'node:crypto';
import { safeEqual } from './auth.js';

/**
 * Signed customer acceptance tokens — the public face of an offer is
 * authenticated by an HMAC signature instead of an account.
 *
 * When an offer is sent it gets a stable token, hmac("offer.<ref>"),
 * where <ref> is the offer number (OFF-2026-0001). The link you email
 * the customer carries this token; anyone with it can view the offer and
 * accept or reject it, anyone without it gets a 404 — even for a real
 * ref, so refs leak nothing.
 *
 * The token is stateless: nothing to store, nothing to expire. It reuses
 * the same SESSION_SECRET as the admin session; the distinct "offer."
 * payload prefix keeps it unusable as a session token and vice versa.
 */

export function offerToken(secret: string, ref: string): string {
  return createHmac('sha256', secret).update(`offer.${ref}`).digest('hex');
}

export function verifyOfferToken(secret: string, ref: string, token: unknown): boolean {
  return typeof token === 'string' && token !== '' && safeEqual(token, offerToken(secret, ref));
}
