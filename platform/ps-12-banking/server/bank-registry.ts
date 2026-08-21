import type { BtfInput } from '../shared/types.js';

/**
 * Bank profiles, as config-as-code — the PS-05 `provider-registry.ts` pattern.
 *
 * ## Where these values come from
 *
 * The German entries are transcribed from **"Mappingtabelle BTF-Struktur auf
 * die Standard-Auftragsartenkennungen"**, the official table published at
 * `ebics.de`, final version of 27 February 2026. They are marked `confirmed`
 * because that document is the source of truth for the German market, not
 * because anyone has run them past a bank.
 *
 * Everything else is `confirmed: false` and deliberately minimal. An earlier
 * version of this file shipped invented values for four countries — a `PSR`
 * service name that does not exist, and a scope-plus-container combination
 * that names a different order type than intended. They were plausible, which
 * is exactly what made them dangerous, and only the published table showed it.
 *
 * ## What is deliberately NOT here
 *
 * **No URLs, and no host ids.** Those arrive on the EBICS contract the bank
 * sends a customer and differ per customer and per environment. A registry
 * that shipped a guessed URL would fail as a connection timeout rather than as
 * "you have not entered your bank's details".
 *
 * ## What a profile is for
 *
 * A wrong BTF is the most common reason a technically perfect upload is
 * refused. The service itself does not care — `submitOrder` takes whatever BTF
 * the caller hands it, or falls back to the connection's profile — so this is
 * a starting point for an operator, and `?validate=1` is how it gets checked
 * without money moving.
 */

export interface BankProfile {
  key: string;
  name: string;
  /** Uploading a SEPA credit transfer — what MOD-04 produces. */
  creditTransfer: BtfInput;
  /** Downloading an account statement. */
  statement: BtfInput;
  /** Downloading a payment status report. */
  paymentStatus: BtfInput;
  /**
   * The EBICS 2.5 order types these replace. Not sent anywhere — banks still
   * talk in them ("we've enabled CCT and C53 for you"), and an operator on the
   * phone needs the translation.
   */
  legacyOrderTypes: { creditTransfer: string; statement: string; paymentStatus: string };
  /**
   * Segment size in base64 characters. The protocol's own maximum is 1 MB;
   * a bank may publish less, and a profile is where that goes.
   */
  segmentLimit: number;
  /** True when the values come from a published mapping table, not a guess. */
  confirmed: boolean;
  /** Where the values came from, so the next person can check them. */
  source: string;
  notes: string;
}

/** The protocol's maximum, and every profile's default. */
export const PROTOCOL_SEGMENT_LIMIT = 1_000_000;

const DE_SOURCE =
  'Mappingtabelle BTF-Struktur auf die Standard-Auftragsartenkennungen, ebics.de, Endfassung 27.02.2026';

export const REGISTRY: readonly BankProfile[] = [
  {
    key: 'de-sepa',
    name: 'SEPA · Germany (GBIC/DK)',
    // CCT: no Scope and no Container. The table is explicit that adding both
    // makes it CCC — the variant for several files in an XML container, which
    // is NOT what a single pain.001 is. ServiceOption left empty, which the
    // table's footnote says is read as VOO (Verification of Payee opt-out).
    creditTransfer: { service_name: 'SCT', msg_name: 'pain.001', msg_variant: '001', msg_version: '03' },
    // C53.
    statement: { service_name: 'EOP', scope: 'DE', msg_name: 'camt.053', container: 'ZIP' },
    // CRZ. The ServiceOption is what says WHICH scheme the report is about:
    // SCT for credit transfers, SDD for direct debits.
    paymentStatus: {
      service_name: 'REP',
      scope: 'DE',
      option: 'SCT',
      msg_name: 'pain.002',
      container: 'ZIP',
    },
    legacyOrderTypes: { creditTransfer: 'CCT', statement: 'C53', paymentStatus: 'CRZ' },
    segmentLimit: PROTOCOL_SEGMENT_LIMIT,
    confirmed: true,
    source: DE_SOURCE,
    notes:
      'From 11/2026 the German table permits only pain.001.001.09 for SEPA credit transfers (GBIC 4/5), and only ' +
      'pain.002.001.10 for status reports. MOD-04 still produces pain.001.001.03, so set msg_version explicitly ' +
      'once that changes. ServiceOption VOO/VOI selects Verification of Payee opt-out/opt-in; empty reads as VOO.',
  },
  {
    key: 'at-sepa',
    name: 'SEPA · Austria (unconfirmed)',
    // Shaped like the German entries but with the Austrian scope, and marked
    // unconfirmed because the Austrian mapping (ebics.psa.at) has not been
    // read. Do not trust the scope or the ServiceOption without checking it.
    creditTransfer: { service_name: 'SCT', msg_name: 'pain.001', msg_variant: '001', msg_version: '03' },
    statement: { service_name: 'EOP', scope: 'AT', msg_name: 'camt.053', container: 'ZIP' },
    paymentStatus: { service_name: 'REP', scope: 'AT', option: 'SCT', msg_name: 'pain.002', container: 'ZIP' },
    legacyOrderTypes: { creditTransfer: 'CCT', statement: 'C53', paymentStatus: 'CRZ' },
    segmentLimit: PROTOCOL_SEGMENT_LIMIT,
    confirmed: false,
    source: 'shaped after the German table; the Austrian mapping at ebics.psa.at has NOT been checked',
    notes:
      'Austria publishes its own BTF mapping. Until it has been read, treat the scope and the service option here ' +
      'as guesses: check them against your bank’s documentation and confirm with POST /api/orders?validate=1.',
  },
  {
    key: 'generic',
    name: 'Generic SEPA (no scope)',
    // No Scope at all, which the German table calls "globale Verwendung" and
    // uses for the plain credit transfer. The right starting point when a
    // bank's documentation says nothing about scope.
    creditTransfer: { service_name: 'SCT', msg_name: 'pain.001' },
    statement: { service_name: 'EOP', msg_name: 'camt.053', container: 'ZIP' },
    paymentStatus: { service_name: 'REP', option: 'SCT', msg_name: 'pain.002', container: 'ZIP' },
    legacyOrderTypes: { creditTransfer: 'CCT', statement: 'C53', paymentStatus: 'CRZ' },
    segmentLimit: PROTOCOL_SEGMENT_LIMIT,
    confirmed: false,
    source: 'the shape every market shares; scopes and options deliberately omitted',
    notes:
      'Start here when the bank’s documentation does not mention a scope. Some banks want the country code, some ' +
      'want it omitted, and a few want "BIL" for a bilaterally agreed service.',
  },
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
    if (entry.source.trim() === '') throw new Error(`bank-registry: "${entry.key}" does not say where it came from`);
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
      if (btf.container !== undefined && !/^[A-Z]{3}$/.test(btf.container)) {
        throw new Error(`bank-registry: "${entry.key}".${label} container must be a 3-letter code (XML, ZIP, SVC)`);
      }
    }
  }
})();
