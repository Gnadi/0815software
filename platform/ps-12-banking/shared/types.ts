/**
 * PS-12 Banking — the wire contract, shared between this server and
 * `@0815software/platform-clients`.
 *
 * Two things are deliberately absent, and their absence is the design:
 *
 * - **No key material.** Nothing in this file can carry a private key. The
 *   most a caller ever sees of one is a digest, which is a value meant to be
 *   read aloud and compared against a bank's letter.
 * - **Nothing about invoices or bills.** The service takes bytes, a BTF and an
 *   idempotency key. Keeping the payload opaque is what lets any module that
 *   can produce an ISO 20022 file reach the bank without this service growing
 *   an opinion about that module's domain.
 */

export interface FieldError {
  field: string;
  message: string;
}

// ── Connections and their key lifecycle ───────────────────────────────

/**
 * DERIVED connection state, folded from the append-only event stream. It moves
 * in one direction, and the step that matters is the last one before `ready`:
 *
 *   created          the access exists; no keys yet
 *   keys_generated   our three key pairs exist, encrypted at rest
 *   ini_sent         the bank has our signature key
 *   hia_sent         the bank has our auth and encryption keys
 *   hpb_fetched      we have the bank's keys — NOT yet trusted
 *   ready            a human confirmed the bank's key digests; orders allowed
 *   suspended        deliberately stopped HERE; orders refused, resumable
 *   locked           the bank locked the subscriber after SPR; NOT resumable
 *   failed           the bank refused a setup step
 *
 * `suspended` and `locked` look alike and are not. Suspending is a local
 * decision and `resume` undoes it. `locked` records that the BANK has revoked
 * the subscriber's authorisation, which nothing in this service can undo: the
 * way back is new keys and a fresh INI/HIA, on paper.
 *
 * `hpb_fetched` is not `ready` on purpose. The HPB response cannot prove it
 * came from the bank, so an operator has to compare the digests against what
 * the bank published — that comparison, not the protocol, is what makes a
 * substituted key visible.
 */
export const CONNECTION_STATES = [
  'created',
  'keys_generated',
  'ini_sent',
  'hia_sent',
  'hpb_fetched',
  'ready',
  'suspended',
  'locked',
  'failed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** What the API shows about one of our keys. Never the key itself. */
export interface SubscriberKeyInfo {
  purpose: 'ES' | 'AUTH' | 'ENC';
  version: string;
  /** Base64 SHA-256 of the public key, as EBICS defines the hash. */
  digest: string;
  /** The same value grouped in eights, to be read off a printed page. */
  digestFormatted: string;
  created_at: string;
}

/** One of the bank's keys, and whether a human has vouched for it. */
export interface BankKeyInfo {
  purpose: 'AUTH' | 'ENC';
  version: string;
  digest: string;
  digestFormatted: string;
  fetched_at: string;
  /** Null until an operator confirmed this digest against the bank's letter. */
  verified_at: string | null;
  verified_by: string | null;
}

export interface ConnectionEvent {
  type: string;
  actor: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Connection {
  key: string;
  display_name: string;
  bank_key: string;
  url: string;
  host_id: string;
  partner_id: string;
  user_id: string;
  ebics_version: string;
  es_version: string;
  debtor_iban: string | null;
  /**
   * The `Product` element: which client software the bank sees, and the id it
   * issued for it. Null throughout means no `Product` element is sent, which
   * is what H005 allows and what every bank tried so far accepts.
   */
  product_name: string | null;
  /** ISO 639 two-letter code. Required by the schema whenever a name is set. */
  product_language: string | null;
  product_institute_id: string | null;
  /**
   * True when uploads ask the bank to spool into its distributed-signature
   * (VEU/EDS) queue instead of carrying every required signature themselves.
   * False — the default — is signature class E: this service's own signature
   * is the whole authorisation.
   */
  request_eds: boolean;
  /**
   * Verification of Payee. `default` sends no ServiceOption and lets the
   * market's own default decide (opt-out, in both published tables);
   * `opt_out` and `opt_in` say so explicitly with VOO / VOI.
   */
  vop: 'default' | 'opt_out' | 'opt_in';
  /** Ceilings enforced before anything is signed — see the service README. */
  max_amount_minor: number;
  max_transfers: number;
  state: ConnectionState;
  created_at: string;
}

export interface ConnectionDetail extends Connection {
  keys: SubscriberKeyInfo[];
  bank_keys: BankKeyInfo[];
  events: ConnectionEvent[];
}

// ── Orders ────────────────────────────────────────────────────────────

/**
 * DERIVED order status, folded from its event stream.
 *
 *   queued       accepted by this service, not yet sent
 *   initialised  the bank assigned a transaction id
 *   transferred  every segment is with the bank
 *   accepted     the bank took the FILE — not the same as having paid it
 *   settled      a pain.002 said the money moved (ACSC)
 *   rejected     the bank refused it, with a code
 *   failed       the conversation broke; whether the bank has it is unknown
 *
 * Three distinctions here are load-bearing:
 *
 * - `failed` and `rejected` must not be merged: a rejection is a decision, a
 *   failure is an unknown, and only one of them is safe to resubmit.
 * - `accepted` and `settled` must not be merged either. A bank accepting a
 *   file says the file was well-formed and authorised; whether each transfer
 *   in it reached its creditor is a later, separate answer that arrives in a
 *   payment status report.
 * - `accepted` is therefore NOT final. An order can be accepted on Monday and
 *   rejected on Wednesday, and the fold lets the later word win.
 */
export const ORDER_STATUSES = [
  'queued',
  'initialised',
  'transferred',
  'accepted',
  'settled',
  'rejected',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The Business Transaction Format, as a bank documents it. */
export interface BtfInput {
  service_name: string;
  scope?: string;
  option?: string;
  msg_name: string;
  /** For pain.001.001.09: version "09". */
  msg_version?: string;
  /** For pain.001.001.09: variant "001". */
  msg_variant?: string;
  /** Encoding format, e.g. "XML". Rarely needed. */
  msg_format?: string;
  /** Container type, e.g. "XML" or "ZIP" — sent as `<Container containerType>`. */
  container?: string;
}

export interface OrderEvent {
  type: string;
  ebics_code: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Order {
  public_id: string;
  connection: string;
  /** The MsgId parsed out of the payload — the file's own identity. */
  msg_id: string;
  btf: BtfInput;
  status: OrderStatus;
  /** SHA-256 of exactly the bytes that were signed. */
  payload_sha256: string;
  amount_minor: number | null;
  tx_count: number | null;
  transaction_id: string | null;
  created_by: string | null;
  created_at: string;
  /** The bank's last word, when it said one. */
  ebics_code: string | null;
  message: string | null;
}

export interface OrderDetail extends Order {
  events: OrderEvent[];
}

/** What `POST /api/orders` takes. */
export interface SubmitOrderInput {
  connection: string;
  btf: BtfInput;
  /** The file itself, base64. Opaque to this service. */
  payload_base64: string;
  /**
   * The caller's own key for this submission — MOD-04 sends
   * `payment-run:<MsgId>`. A retry with the same key returns the first order
   * rather than creating a second one.
   */
  idempotency_key?: string;
}

/** A dry run: what would be sent, without sending it. */
export interface OrderPreview {
  msg_id: string;
  payload_sha256: string;
  amount_minor: number | null;
  tx_count: number | null;
  btf: BtfInput;
  /** Problems that would stop the submission, if any. */
  problems: FieldError[];
}

// ── Downloads (phase 6) ───────────────────────────────────────────────

/**
 * What kind of file the bank handed over.
 *
 *   statement  camt.053 — an account statement, READ into bookings (see
 *              server/camt.ts). Deciding which invoice a booking settles is
 *              still a module's business; reading the format is not.
 *   status     pain.002 — a payment status report. The answer to "did that
 *              file go through?", so this one IS read.
 *   info       CIM — a notice the bank wants a PERSON to read. Read far
 *              enough to show its text; see server/cim.ts for the ceiling.
 *   protocol   HAC — the customer acknowledgement, the bank's own log of what
 *              it did with every order. ALSO a pain.002, which is exactly why
 *              it needs a kind of its own; see server/hac.ts.
 *   other      anything else a BTF names. Kept, offered, not understood.
 */
export const DOWNLOAD_KINDS = ['statement', 'status', 'info', 'protocol', 'other'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

export interface DownloadRow {
  public_id: string;
  connection: string;
  kind: DownloadKind;
  btf: BtfInput;
  sha256: string;
  byte_length: number;
  fetched_at: string;
  /**
   * When the positive receipt was sent. Null means the bank still believes we
   * do not have this file and will offer it again — which is the safe
   * direction, and why the receipt goes out only after the bytes are stored.
   */
  acknowledged_at: string | null;
  processed_at: string | null;
}

export interface DownloadDetail extends DownloadRow {
  reports: {
    msg_id: string | null;
    status_code: string;
    reason_code: string | null;
    reason: string | null;
    created_at: string;
  }[];
  /**
   * For `kind: 'info'` only — what a CIM said, read against its published
   * schema. Absent for every other kind, and null for a CIM this could not
   * parse: the bytes are stored either way.
   *
   * `text` is HTML from outside this system. Anything rendering it must escape
   * or sanitise it; the schema names which tags a bank may use and says a
   * client ignores the rest, which is a display rule, not a safety guarantee.
   */
  customer_info?: {
    message_id: string;
    created_at: string;
    notices: { id: string; timestamp: string; headline: string | null; text: string }[];
  } | null;
  /**
   * For `kind: 'protocol'` only — what a HAC logged, read against the schema
   * the EBICS Working Group publishes with it.
   *
   * `entries` are the bank's own actions in the order it recorded them;
   * `orders` folds them per EBICS order number, which is the form an operator
   * asking "what happened to that payment?" actually wants.
   */
  customer_protocol?: {
    message_id: string;
    created_at: string;
    host_id: string | null;
    entries: HacEntrySummary[];
    orders: { order_id: string; verdict: HacOrderVerdict; entries: HacEntrySummary[] }[];
  } | null;
}

/** What the bank's log says became of one order. */
export type HacOrderVerdict = 'processed' | 'failed' | 'in_progress';

/** One logged action, as the API hands it over. */
export interface HacEntrySummary {
  action: string;
  user_id: string | null;
  partner_id: string | null;
  order_id: string | null;
  admin_order_type: string | null;
  service_name: string | null;
  msg_name: string | null;
  timestamp: string | null;
  /** The order this action is ABOUT, when it is not the one it names. */
  references_order_id: string | null;
  reason_code: string | null;
  /** Free text; on the final entry, the bank's display file. */
  additional_info: string | null;
}

/** What one `POST /api/tick` did. */
export interface TickResult {
  downloads_fetched: number;
  orders_updated: number;
  /** Account statements read into bookings this pass. */
  statements_read: number;
  /** Connections that could not be reached, with the reason. Not an error. */
  problems: { connection: string; message: string }[];
}

// ── Account statements ────────────────────────────────────────────────

/**
 * One account's statement, as read out of a `camt.053`.
 *
 * The balances are SIGNED here — a closing balance is a position, and a
 * consumer comparing two of them needs the direction in the number. An
 * ENTRY's amount is not: ISO puts the direction in a separate indicator and
 * never a minus sign, and this keeps faith with what the bank sent.
 */
export interface StatementRow {
  public_id: string;
  connection: string;
  /** The download it was read out of, so the original bytes stay reachable. */
  download: string | null;
  /**
   * Which of the three account messages this came from.
   *
   *   statement     camt.053, end of day — the definitive record
   *   report        camt.052, intraday and PROVISIONAL: every booking on it
   *                 appears AGAIN on the day's statement
   *   notification  camt.054, individual items as they happen — same caveat
   *
   * They share an entry structure, which is why one reader serves all three.
   * They do not share a meaning, which is why summing across them
   * double-counts and why queries default to statements alone.
   */
  source: 'statement' | 'report' | 'notification';
  /** The ISO message name, e.g. "camt.053.001.02". */
  message_name: string | null;
  /** The schema version, e.g. "02" or "08". They differ materially. */
  version: string;
  message_id: string;
  statement_id: string;
  electronic_seq: number | null;
  legal_seq: number | null;
  created_at: string | null;
  from_date: string | null;
  to_date: string | null;
  account: {
    iban: string | null;
    other: string | null;
    currency: string | null;
    name: string | null;
    owner: string | null;
  };
  opening_balance: string | null;
  closing_balance: string | null;
  balance_currency: string | null;
  entry_count: number;
}

/**
 * One booking.
 *
 * `amount` is exactly what the bank wrote, unsigned; `credit` carries the
 * direction. `amount_hundredths` is that amount times one hundred and is
 * deliberately NOT called `amount_minor`: minor units need the currency's
 * exponent — two for the euro, zero for the yen, three for the dinar — and
 * this service does not ship that table. Null when the bank sent more than
 * two decimal places.
 */
export interface StatementEntryRow {
  statement: string;
  /** Which account message it came from — see `StatementRow.source`. */
  source: 'statement' | 'report' | 'notification';
  account_iban: string | null;
  seq: number;
  amount: string;
  amount_hundredths: number | null;
  currency: string;
  /** True when money came IN. */
  credit: boolean;
  /** True when this entry undoes an earlier one. Do not sum it as income. */
  reversal: boolean;
  /** `BOOK` booked, `PDNG` pending — a pending entry is not money yet. */
  status: string;
  booking_date: string | null;
  value_date: string | null;
  entry_ref: string | null;
  account_servicer_ref: string | null;
  bank_transaction_code: string | null;
  end_to_end_id: string | null;
  mandate_id: string | null;
  msg_id: string | null;
  payment_info_id: string | null;
  instruction_id: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  remittance: string | null;
  /** The structured creditor reference — where an invoice number belongs. */
  creditor_reference: string | null;
  purpose: string | null;
  return_reason: string | null;
  additional_info: string | null;
}
