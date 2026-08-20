import type { BtfInput } from '../shared/types.js';

/**
 * Bank profiles, as config-as-code — the PS-05 `provider-registry.ts` pattern.
 *
 * ## What is deliberately NOT here
 *
 * **No URLs, and no host ids.** Those arrive on the EBICS contract the bank
 * sends a customer, together with the partner and user ids, and they differ per
 * customer and per environment. A registry that shipped a guessed URL would be
 * a plausible-looking value pointing at nothing, and the failure would surface
 * as a connection timeout rather than as "you have not entered your bank's
 * details". So the operator supplies them, always.
 *
 * **No named banks.** The same reasoning as the return-code table in
 * `ebics/codes.ts`: a confidently-worded wrong value next to a payment is worse
 * than no value. What a profile encodes instead is the part that is genuinely
 * standardised — the shape of a Business Transaction Format for a given scheme
 * and country.
 *
 * ## What a profile is for
 *
 * BTF is EBICS 3.0's replacement for the old order types, and a wrong BTF is
 * the most common reason a technically perfect upload is refused. The service
 * itself does not care: `submitOrder` takes whatever BTF the caller hands it.
 * A profile is a *starting point* for an operator setting a connection up, and
 * `previewOrder` is how it gets checked without money moving.
 *
 * Every profile is therefore marked `confirmed: false` until someone has
 * checked it against a bank's own EBICS documentation. Nothing in this repo
 * can do that check.
 */

export interface BankProfile {
  key: string;
  name: string;
  /** Uploading a SEPA credit transfer — what MOD-04 produces. */
  creditTransfer: BtfInput;
  /** Downloading an account statement (phase 6). */
  statement: BtfInput;
  /** Downloading a payment status report (phase 6). */
  paymentStatus: BtfInput;
  /**
   * Segment size in base64 characters. The protocol's own maximum is 1 MB;
   * a bank may publish less, and a profile is where that goes.
   */
  segmentLimit: number;
  /**
   * True only once a human has checked these values against the bank's own
   * documentation. Nothing here ships as `true`.
   */
  confirmed: boolean;
  notes: string;
}

/** The protocol's maximum, and every profile's default. */
export const PROTOCOL_SEGMENT_LIMIT = 1_000_000;

const SEPA_NOTE =
  'Scope is the country code of the bank, per the BTF catalogue. Confirm the service names and message ' +
  'versions against the bank’s own EBICS documentation before the first live order — a preview (POST ' +
  '/api/orders?validate=1) shows what would be sent without signing anything.';

/** A SEPA profile differs from its neighbours only in `scope`. */
function sepa(key: string, name: string, scope: string | undefined, notes = SEPA_NOTE): BankProfile {
  const scoped = scope === undefined ? {} : { scope };
  return {
    key,
    name,
    creditTransfer: { service_name: 'SCT', ...scoped, msg_name: 'pain.001', msg_version: '03', container: 'XML' },
    statement: { service_name: 'EOP', ...scoped, msg_name: 'camt.053', msg_version: '04', container: 'ZIP' },
    paymentStatus: { service_name: 'PSR', ...scoped, msg_name: 'pain.002', msg_version: '03', container: 'ZIP' },
    segmentLimit: PROTOCOL_SEGMENT_LIMIT,
    confirmed: false,
    notes,
  };
}

export const REGISTRY: readonly BankProfile[] = [
  sepa(
    'generic',
    'Generic SEPA (no scope)',
    undefined,
    'No scope element at all. Some banks want the country code, some want it omitted, and a few want "BIL" ' +
      'for a bilaterally agreed service. Start here only if the bank’s documentation does not say. ' +
      SEPA_NOTE,
  ),
  sepa('sepa-at', 'SEPA · Austria', 'AT'),
  sepa('sepa-de', 'SEPA · Germany', 'DE'),
  sepa('sepa-ch', 'SEPA · Switzerland', 'CH'),
  sepa('sepa-fr', 'SEPA · France', 'FR'),
];

export function bankProfile(key: string): BankProfile | undefined {
  return REGISTRY.find((entry) => entry.key === key);
}

/** What `GET /api/banks` answers with. */
export function publicRegistry(): BankProfile[] {
  return REGISTRY.map((entry) => ({ ...entry }));
}

// ── Import-time self-check ────────────────────────────────────────────
//
// A malformed profile becomes a refused upload at the bank, hours after the
// deploy. Catching it at import means it is a boot failure instead.
(function selfCheck(): void {
  const keys = new Set<string>();
  for (const entry of REGISTRY) {
    if (keys.has(entry.key)) throw new Error(`bank-registry: duplicate key "${entry.key}"`);
    keys.add(entry.key);
    if (entry.name.trim() === '') throw new Error(`bank-registry: "${entry.key}" has no name`);
    if (entry.segmentLimit < 1 || entry.segmentLimit > PROTOCOL_SEGMENT_LIMIT) {
      throw new Error(`bank-registry: "${entry.key}" has a segment limit outside 1..${PROTOCOL_SEGMENT_LIMIT}`);
    }
    for (const [label, btf] of [
      ['creditTransfer', entry.creditTransfer],
      ['statement', entry.statement],
      ['paymentStatus', entry.paymentStatus],
    ] as const) {
      if (btf.service_name.trim() === '') throw new Error(`bank-registry: "${entry.key}".${label} has no service name`);
      if (btf.msg_name.trim() === '') throw new Error(`bank-registry: "${entry.key}".${label} has no message name`);
      if (btf.scope !== undefined && !/^([A-Z]{2}|BIL)$/.test(btf.scope)) {
        throw new Error(`bank-registry: "${entry.key}".${label} scope must be a country code or "BIL"`);
      }
    }
  }
})();
