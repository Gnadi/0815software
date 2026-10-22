import type { SellerSource } from './seller-settings.js';

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
 * - PS-11 has none → the env values stand. PS-11 unreachable → the last party
 *   it gave stands (see `refreshSellerSource`). A module never *writes* the
 *   seller to PS-11: one authority, set once by the operator with `PUT /api/self`.
 *
 * Above both sits the Settings screen; `SellerSource` (server/seller-settings.ts)
 * combines the three and updates the live config object in place, because
 * `createApp` captured it and the PDF renderer reads its fields at render time.
 * That is what lets a refresh take effect without a restart.
 */

/** The subset of a PS-11 party this module needs for a letterhead. */
export interface SelfParty {
  name: string;
  vat_id: string | null;
  address_lines: string[];
  iban: string | null;
  bic: string | null;
}

/** Fetch the `self` party: null when PS-11 is unset or has none, a throw when unreachable. */
export type FetchSelf = () => Promise<SelfParty | null>;

/** How often a long-running process re-reads the seller from PS-11. */
export const SELLER_REFRESH_MS = 5 * 60_000;

/**
 * Re-read PS-11's `self` party into the seller sources. PS-11's party is ONE of
 * the sources (server/seller-settings.ts), so a refresh can never overwrite
 * what was saved on the Settings screen. Returns true when PS-11 supplied a
 * party.
 *
 * "No party" (null) and "PS-11 unreachable" (a throw) are deliberately
 * different: the first clears PS-11's fields so the next source stands; the
 * second changes nothing, because the last party PS-11 gave is far closer to
 * the truth than the env placeholders — and whatever the seller is at the
 * moment an invoice is finalized is frozen into it for good.
 */
export async function refreshSellerSource(source: SellerSource, fetchSelf: FetchSelf): Promise<boolean> {
  let self: SelfParty | null;
  try {
    self = await fetchSelf();
  } catch {
    return false; // unreachable: keep the last known state, see above
  }
  source.setPlatform(self);
  return self !== null;
}

export function startSellerSourceRefresh(
  source: SellerSource,
  fetchSelf: FetchSelf,
  intervalMs = SELLER_REFRESH_MS,
): () => void {
  const timer = setInterval(() => void refreshSellerSource(source, fetchSelf), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
