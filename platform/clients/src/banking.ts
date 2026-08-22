import { BaseClient } from './http.js';

/**
 * Client for PS-12 Banking (default port 4012).
 *
 * The service is payload-agnostic on purpose: a module hands over bytes, a BTF
 * and an idempotency key, and gets back an order whose status it can poll.
 * Nothing about invoices or bills is in it, so any module that can produce an
 * ISO 20022 file reaches the bank through these three methods.
 *
 * Two things worth knowing before calling `submitOrder`:
 *
 * - **The service token cannot set a connection up.** Creating a bank
 *   connection, generating keys and confirming the bank's digests are an
 *   operator's routes and answer 403 to a machine credential. A module submits
 *   against a connection a human already activated.
 * - **Submitting twice is safe, and is meant to be.** Pass a stable
 *   `idempotencyKey` — MOD-04 uses `payment-run:<MsgId>` — and a retry returns
 *   the first order instead of paying twice. The service deduplicates on the
 *   file's own MsgId as well, so a caller that forgets the key is still
 *   covered.
 */
export class BankingClient extends BaseClient {
  /** Submit a file to the bank. Idempotent on `idempotencyKey`. */
  submitOrder(input: SubmitOrderInput): Promise<BankOrder> {
    return this.apiPost<BankOrder>('/api/orders', {
      connection: input.connection,
      btf: input.btf,
      payload_base64: input.payload.toString('base64'),
      idempotency_key: input.idempotencyKey,
    });
  }

  /**
   * What would be sent, without sending it.
   *
   * Signs nothing and stores nothing, so it is safe to call as often as you
   * like — which is the point: check a file against a connection's ceilings and
   * the bank's BTF before committing to it.
   */
  previewOrder(input: SubmitOrderInput): Promise<OrderPreview> {
    return this.apiPost<OrderPreview>('/api/orders?validate=1', {
      connection: input.connection,
      btf: input.btf,
      payload_base64: input.payload.toString('base64'),
    });
  }

  getOrder(publicId: string): Promise<BankOrder> {
    return this.apiGet(`/api/orders/${encodeURIComponent(publicId)}`);
  }

  listOrders(connection?: string): Promise<{ orders: BankOrder[] }> {
    const query = connection === undefined ? '' : `?connection=${encodeURIComponent(connection)}`;
    return this.apiGet(`/api/orders${query}`);
  }

  /** The bank profiles the service knows — BTF conventions, no URLs. */
  listBanks(): Promise<{ banks: BankProfile[] }> {
    return this.apiGet('/api/banks');
  }

  /**
   * What the bank has handed over — statements and payment status reports.
   *
   * Metadata only: the files themselves are on their own route, so a listing
   * never drags megabytes of XML through a module that only wanted to know
   * whether anything arrived.
   */
  listDownloads(opts: { connection?: string; kind?: DownloadKind } = {}): Promise<{ downloads: BankDownload[] }> {
    const query = new URLSearchParams();
    if (opts.connection !== undefined) query.set('connection', opts.connection);
    if (opts.kind !== undefined) query.set('kind', opts.kind);
    const suffix = query.toString();
    return this.apiGet(`/api/downloads${suffix === '' ? '' : `?${suffix}`}`);
  }

  getDownload(publicId: string): Promise<BankDownloadDetail> {
    return this.apiGet(`/api/downloads/${encodeURIComponent(publicId)}`);
  }

  /** The account statements the service has read into bookings. */
  listStatements(opts: { connection?: string; account?: string; limit?: number } = {}): Promise<{
    statements: BankStatement[];
  }> {
    return this.apiGet(`/api/statements${queryString(opts as Record<string, unknown>)}`);
  }

  getStatement(publicId: string): Promise<BankStatement & { entries: BankEntry[] }> {
    return this.apiGet(`/api/statements/${encodeURIComponent(publicId)}`);
  }

  /**
   * Find bookings — the query a payment matcher needs.
   *
   * The service reads the bank's camt.053 and hands over what it booked. It
   * does NOT decide which invoice a booking settles: that depends on the
   * invoices, and those are yours. So the flow is: ask here with whatever you
   * know (a reference you put on the payment, an amount, a date range), then
   * decide.
   *
   * Two defaults worth knowing:
   *
   * - **Only booked entries come back.** A `PDNG` entry is money the bank has
   *   seen and not booked; treating it as a payment is how an invoice gets
   *   marked settled against a transaction that later vanishes. Pass
   *   `status: 'PDNG'` if you really want them.
   * - **Reversals are included.** An entry with `reversal: true` undoes an
   *   earlier one — pass `excludeReversals` when summing.
   */
  findEntries(query: EntryQuery = {}): Promise<{ entries: BankEntry[] }> {
    return this.apiGet(
      `/api/entries${queryString({
        connection: query.connection,
        account: query.account,
        from: query.from,
        to: query.to,
        credit: query.credit,
        status: query.status,
        end_to_end_id: query.endToEndId,
        reference: query.reference,
        amount_hundredths: query.amountHundredths,
        search: query.search,
        exclude_reversals: query.excludeReversals,
        limit: query.limit,
      })}`,
    );
  }

  /**
   * Run the periodic pass: fetch what is waiting, fold status reports into
   * the orders they are about.
   *
   * Answers with what it did rather than throwing on an unreachable bank —
   * one bank being down does not stop the others being polled.
   */
  tick(): Promise<TickResult> {
    return this.apiPost<TickResult>('/api/tick', {});
  }
}

/** `?a=1&b=2`, with empty and undefined values dropped. */
function queryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const suffix = query.toString();
  return suffix === '' ? '' : `?${suffix}`;
}

/**
 * What kind of file the bank handed over.
 *
 *   statement  camt.053 — an account statement, READ into bookings you can
 *              query; see findEntries
 *   status     pain.002 — a payment status report, which IS read, because it
 *              is the answer to "did that payment file go through?"
 *   other      anything else a BTF names
 */
export type DownloadKind = 'statement' | 'status' | 'info' | 'protocol' | 'other';

export interface BankDownload {
  public_id: string;
  connection: string;
  kind: DownloadKind;
  btf: Btf;
  sha256: string;
  byte_length: number;
  fetched_at: string;
  /** Null means the bank has not been told we have it, and will offer again. */
  acknowledged_at: string | null;
  processed_at: string | null;
}

export interface BankDownloadDetail extends BankDownload {
  reports: {
    msg_id: string | null;
    /** The ISO 20022 status, passed through: ACSC, RJCT, PDNG, … */
    status_code: string;
    reason_code: string | null;
    reason: string | null;
    created_at: string;
  }[];
}

export interface TickResult {
  downloads_fetched: number;
  orders_updated: number;
  /** Connections that could not be reached. Reported, not thrown. */
  problems: { connection: string; message: string }[];
}

/** The Business Transaction Format, as a bank documents it. */
export interface Btf {
  service_name: string;
  scope?: string;
  option?: string;
  msg_name: string;
  msg_version?: string;
  container?: string;
}

export interface SubmitOrderInput {
  /** The connection key an operator created, e.g. "main". */
  connection: string;
  /**
   * Optional. Omitted — the ordinary case — the connection's own bank profile
   * supplies it, so a module that has produced a pain.001 does not also have
   * to know that this bank wants `SCT/AT/pain.001/XML` and the one next door
   * wants no scope at all. Pass one only to override that.
   */
  btf?: Btf;
  /** The file itself. Opaque to the service. */
  payload: Buffer;
  /** Stable per file — MOD-04 uses `payment-run:<MsgId>`. */
  idempotencyKey?: string;
}

/**
 * An order's status.
 *
 * `rejected` and `failed` are not the same thing, and a caller must not merge
 * them: a rejection is a decision the bank made and told us about, a failure is
 * a conversation that broke and whether the bank has the file is **unknown**.
 * Only one of the two is safe to resubmit.
 */
export type BankOrderStatus =
  | 'queued'
  | 'initialised'
  | 'transferred'
  /** The bank took the FILE. Not the same as having paid it. */
  | 'accepted'
  /** A payment status report said the money moved (ISO 20022 `ACSC`). */
  | 'settled'
  | 'rejected'
  /** The conversation broke; whether the bank holds the file is unknown. */
  | 'failed';

export interface BankOrder {
  public_id: string;
  connection: string;
  /** The file's own identity — its MsgId, for an ISO 20022 message. */
  msg_id: string;
  btf: Btf;
  status: BankOrderStatus;
  payload_sha256: string;
  amount_minor: number | null;
  tx_count: number | null;
  transaction_id: string | null;
  created_by: string | null;
  created_at: string;
  /** The bank's last word, when it said one. */
  ebics_code: string | null;
  message: string | null;
  events?: { type: string; ebics_code: string | null; meta: Record<string, unknown>; created_at: string }[];
}

export interface OrderPreview {
  msg_id: string;
  payload_sha256: string;
  amount_minor: number | null;
  tx_count: number | null;
  btf: Btf;
  /** Empty when the file would be accepted for submission. */
  problems: { field: string; message: string }[];
}

export interface BankProfile {
  key: string;
  name: string;
  creditTransfer: Btf;
  statement: Btf;
  paymentStatus: Btf;
  segmentLimit: number;
  /** False until a human checked these values against a bank's documentation. */
  confirmed: boolean;
  notes: string;
}

// ── Account statements and the bookings on them ───────────────────────

export interface BankStatement {
  public_id: string;
  connection: string;
  /** The download it was read from — the original bytes stay reachable. */
  download: string | null;
  /** The camt.053 schema version, e.g. "02" or "08". */
  version: string;
  message_id: string;
  statement_id: string;
  electronic_seq: number | null;
  legal_seq: number | null;
  created_at: string | null;
  from_date: string | null;
  to_date: string | null;
  account: { iban: string | null; other: string | null; currency: string | null; name: string | null; owner: string | null };
  /** SIGNED, unlike an entry: a balance is a position, not a movement. */
  opening_balance: string | null;
  closing_balance: string | null;
  balance_currency: string | null;
  entry_count: number;
}

/**
 * One booking.
 *
 * `amount` is exactly what the bank wrote and is never signed — ISO 20022 puts
 * the direction in a separate indicator, which is `credit` here.
 *
 * `amount_hundredths` is that amount times one hundred. It is deliberately NOT
 * called `amount_minor`: minor units need the currency's exponent, which is
 * two for the euro, zero for the yen and three for the dinar. Working in
 * euros, treat it as cents. Null when the bank sent finer granularity than two
 * decimal places, because rounding an amount silently is worse than saying so.
 */
export interface BankEntry {
  statement: string;
  account_iban: string | null;
  seq: number;
  amount: string;
  amount_hundredths: number | null;
  currency: string;
  /** True when money came IN. */
  credit: boolean;
  /** True when this entry undoes an earlier one. Do not sum it as income. */
  reversal: boolean;
  /** `BOOK` booked, `PDNG` pending — pending is not money yet. */
  status: string;
  booking_date: string | null;
  value_date: string | null;
  entry_ref: string | null;
  account_servicer_ref: string | null;
  bank_transaction_code: string | null;
  /** The reference your own pain.001 put on the transaction, if any. */
  end_to_end_id: string | null;
  mandate_id: string | null;
  msg_id: string | null;
  payment_info_id: string | null;
  instruction_id: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  /** Every unstructured remittance line, joined with newlines. */
  remittance: string | null;
  /** The structured creditor reference — where an invoice number belongs. */
  creditor_reference: string | null;
  purpose: string | null;
  /** Why a payment came back, when it did. */
  return_reason: string | null;
  additional_info: string | null;
}

export interface EntryQuery {
  connection?: string;
  account?: string;
  /** Inclusive, on the BOOKING date — when the money actually moved. */
  from?: string;
  to?: string;
  /** True for money in, false for money out; omit for both. */
  credit?: boolean;
  /** Defaults to `BOOK` server-side. */
  status?: string;
  endToEndId?: string;
  reference?: string;
  /** Exact amount in hundredths. */
  amountHundredths?: number;
  /** Substring of the remittance text or the counterparty name. */
  search?: string;
  excludeReversals?: boolean;
  limit?: number;
}
