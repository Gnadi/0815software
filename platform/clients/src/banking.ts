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
  btf: Btf;
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
export type BankOrderStatus = 'queued' | 'initialised' | 'transferred' | 'accepted' | 'rejected' | 'failed';

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
