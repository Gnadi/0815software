import { checkEgressTarget, type EgressPolicy } from './egress.js';
import { DomainError } from './errors.js';
import type { ExchangeScope, ExchangeRecorder } from './exchanges.js';

/**
 * One POST to a bank.
 *
 * Small on purpose: everything that decides *what* to send lives in
 * `ebics/envelopes.ts`, and everything that decides what a reply *means* lives
 * in `ebics/parse.ts`. This file only moves bytes — which is what makes the
 * whole protocol testable by handing it a different `PostLike`.
 *
 * Two things it does do, and both are policy rather than plumbing:
 *
 * - **The egress check runs on the bank URL.** PS-05's guard exists to stop a
 *   configured URL reaching into the private network; here it matters just as
 *   much, because a bank URL is operator input and a "bank" at
 *   `http://ps01:4001` would be handed signed payment files.
 * - **A failed conversation is never silently retried.** Retrying a request
 *   that may already have been accepted is how one payment becomes two, so
 *   retry policy belongs to the caller, which knows whether the order had
 *   reached the bank. This function reports; it does not decide.
 *
 * It is also the only place a bank is spoken to, which is why the exchange
 * recorder lives here: every envelope sent and every answer received is
 * written to `bank_exchanges` from this one function, including the ones that
 * ended in a timeout — those especially, since an unanswered upload is the
 * case where "what exactly did we send, and when" decides who pays.
 */

/** The seam. Tests pass the mock bank; production passes `httpPost`. */
export type PostLike = (url: string, body: string) => Promise<{ status: number; body: string }>;

export interface TransportOptions {
  post?: PostLike;
  egress?: EgressPolicy;
  /** How long to wait for a bank before giving up (ms). */
  timeoutMs?: number;
  /** Where the conversation log goes. Omitted → nothing is kept. */
  record?: ExchangeRecorder;
  /** Injectable clock, so the recorded window is deterministic in tests. */
  now?: () => string;
}

/** The real thing: an HTTPS POST of an EBICS envelope. */
export const httpPost: PostLike = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=UTF-8' },
    body,
  });
  return { status: response.status, body: await response.text() };
};

export class Transport {
  private readonly post: PostLike;
  private readonly egress: EgressPolicy | undefined;
  private readonly timeoutMs: number;
  private readonly record: ExchangeRecorder | undefined;
  private readonly now: () => string;

  constructor(options: TransportOptions = {}) {
    this.post = options.post ?? httpPost;
    this.egress = options.egress;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.record = options.record;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Send one envelope and return the bank's body.
   *
   * A non-2xx status is a DomainError rather than a parsed response: an HTML
   * error page from a load balancer is not an EBICS answer, and treating it as
   * one produces a confusing parse failure three layers away from the cause.
   *
   * `context` names what this round-trip was for. It is optional so a caller
   * that has nothing useful to say does not have to invent something, but
   * every call site in this service passes one — an exchange nobody can tie
   * to an order is evidence of a conversation, not of a payment.
   */
  async send(url: string, body: string, context?: ExchangeScope): Promise<string> {
    if (this.egress !== undefined) {
      const verdict = await checkEgressTarget(url, this.egress);
      if (!verdict.allowed) {
        // Recorded too: a refused egress check is a conversation that did not
        // happen for a reason worth being able to look up later.
        this.log(url, body, context, null, null, `refused by the egress policy: ${verdict.reason}`, this.now(), this.now());
        throw new DomainError(422, `refusing to send to ${url}: ${verdict.reason}`);
      }
    }

    const startedAt = this.now();
    const startedMs = Date.now();
    let result: { status: number; body: string };
    try {
      result = await withTimeout(this.post(url, body), this.timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The bank may or may not have received this. That ambiguity is the
      // caller's to resolve — see how orders.ts records `failed` rather than
      // deciding to resend. It is also exactly why the request is kept: this
      // is the branch where somebody later has to prove what was sent.
      this.log(url, body, context, null, null, message, startedAt, this.now(), Date.now() - startedMs);
      throw new DomainError(502, `the bank could not be reached: ${message}`);
    }

    const ok = result.status >= 200 && result.status < 300;
    this.log(
      url,
      body,
      context,
      result.body,
      result.status,
      ok ? null : `the bank answered HTTP ${result.status}`,
      startedAt,
      this.now(),
      Date.now() - startedMs,
    );
    if (!ok) {
      throw new DomainError(502, `the bank answered HTTP ${result.status}`);
    }
    return result.body;
  }

  /** Write one row, never letting the audit copy break the conversation. */
  private log(
    url: string,
    request: string,
    context: ExchangeScope | undefined,
    response: string | null,
    httpStatus: number | null,
    error: string | null,
    startedAt: string,
    finishedAt: string,
    durationMs = 0,
  ): void {
    if (this.record === undefined) return;
    try {
      this.record({
        connection: context?.connection ?? null,
        order: context?.order ?? null,
        phase: context?.phase ?? 'unknown',
        url,
        request,
        response,
        httpStatus,
        error,
        startedAt,
        finishedAt,
        durationMs,
      });
    } catch {
      // The recorder is already defensive; this is the belt for its braces.
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
