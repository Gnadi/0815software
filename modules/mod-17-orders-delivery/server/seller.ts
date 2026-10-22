/**
 * Where the letterhead comes from — three sources, field by field:
 *
 *   Settings (the admin, on this module's screen)
 *     > PS-11's `self` party (the stack's one record of who the seller is)
 *       > SELLER_* environment (what the stack was provisioned with).
 *
 * The same order as MOD-04, so the two modules cannot print different
 * sellers for one stack unless an admin deliberately set one here.
 *
 * Standalone — CUSTOMERS_URL unset — PS-11 simply never contributes, and no
 * call is made. With PS-11 wired, `fetchSelf` answers null when there is no
 * `self` party (the layer is cleared: the env stands) and THROWS when PS-11
 * is unreachable: then the last party it gave is kept, because an outage
 * that read as "no party" would print the env placeholders on every
 * document written meanwhile.
 */

export interface SelfParty {
  name: string;
  vat_id: string | null;
  address_lines: string[];
}

export type FetchSelf = () => Promise<SelfParty | null>;

/** How often a long-running process re-reads the seller from PS-11. */
export const SELLER_REFRESH_MS = 5 * 60_000;

/** The PS-11 layer: the last `self` party PS-11 gave, or null. */
export class PlatformSeller {
  current: SelfParty | null = null;

  /** Re-read PS-11. True when a party is in force afterwards. */
  async refresh(fetchSelf: FetchSelf): Promise<boolean> {
    try {
      this.current = await fetchSelf();
    } catch {
      // Unreachable: keep what we had (see above).
    }
    return this.current !== null;
  }

  /** Keep it current for the life of the process; the timer never holds it open. */
  start(fetchSelf: FetchSelf, intervalMs = SELLER_REFRESH_MS): () => void {
    const timer = setInterval(() => void this.refresh(fetchSelf), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
