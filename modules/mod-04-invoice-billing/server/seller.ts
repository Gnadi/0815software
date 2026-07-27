import type { SellerConfig } from './config.js';

/**
 * Where the seller letterhead comes from.
 *
 * MOD-04 and MOD-13 both print the seller's name, address and VAT id, and both
 * historically read them from their own `SELLER_*` environment — the same fact
 * configured twice, which `deploy/provision.mjs` had to work around by hoisting
 * `SELLER_*` to stack scope. PS-11 Customers holds that fact once, as its `self`
 * party, so when `CUSTOMERS_URL` is configured the platform is the authority and
 * the env becomes the fallback.
 *
 * The precedence is deliberately one-directional:
 *
 * - PS-11 has a `self` party  → it wins, field by field (a blank field there
 *   falls back to the env, so a half-filled party cannot blank a letterhead).
 * - PS-11 has none, or is unreachable → the env values stand, unchanged. A
 *   module never *writes* the seller to PS-11: one authority, set once by the
 *   operator with `PUT /api/self`.
 *
 * `applySeller` mutates the config object in place because `createApp` captured
 * it and the PDF renderer reads its fields at render time. That is what lets the
 * refresh below take effect without a restart.
 */

/** The subset of a PS-11 party this module needs for a letterhead. */
export interface SelfParty {
  name: string;
  vat_id: string | null;
  address_lines: string[];
  iban: string | null;
  bic: string | null;
}

/** Fetch the `self` party, or null when PS-11 is unset, empty or unreachable. */
export type FetchSelf = () => Promise<SelfParty | null>;

/** How often a long-running process re-reads the seller from PS-11. */
export const SELLER_REFRESH_MS = 5 * 60_000;

/**
 * Overlay PS-11's `self` party onto `seller`, in place. Returns true when
 * anything came from the platform, so a boot can log which authority it used.
 */
export async function applySeller(seller: SellerConfig, fetchSelf: FetchSelf): Promise<boolean> {
  let self: SelfParty | null;
  try {
    self = await fetchSelf();
  } catch {
    return false; // best-effort: an unreachable PS-11 leaves the env in charge
  }
  if (!self) return false;

  if (self.name.trim() !== '') seller.name = self.name.trim();
  if (self.address_lines.length > 0) seller.addressLines = self.address_lines;
  if (self.vat_id) seller.vatId = self.vat_id;
  if (self.iban) seller.iban = self.iban;
  if (self.bic) seller.bic = self.bic;
  return true;
}

/**
 * Keep the seller current for the life of the process. Returns a stop function;
 * the timer is unref'd so it never holds the process open.
 */
export function startSellerRefresh(
  seller: SellerConfig,
  fetchSelf: FetchSelf,
  intervalMs = SELLER_REFRESH_MS,
): () => void {
  const timer = setInterval(() => void applySeller(seller, fetchSelf), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
