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
 *   suspended        deliberately stopped; orders refused
 *   failed           the bank refused a setup step
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
 *   statement  camt.053 — an account statement. Stored whole, never parsed
 *              here: matching bookings to invoices is a module's business.
 *   status     pain.002 — a payment status report. The answer to "did that
 *              file go through?", so this one IS read.
 *   other      anything else a BTF names. Kept, offered, not understood.
 */
export const DOWNLOAD_KINDS = ['statement', 'status', 'other'] as const;
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
}

/** What one `POST /api/tick` did. */
export interface TickResult {
  downloads_fetched: number;
  orders_updated: number;
  /** Connections that could not be reached, with the reason. Not an error. */
  problems: { connection: string; message: string }[];
}
