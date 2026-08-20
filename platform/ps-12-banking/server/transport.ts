import { checkEgressTarget, type EgressPolicy } from './egress.js';
import { DomainError } from './errors.js';

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
 */

/** The seam. Tests pass the mock bank; production passes `httpPost`. */
export type PostLike = (url: string, body: string) => Promise<{ status: number; body: string }>;

export interface TransportOptions {
  post?: PostLike;
  egress?: EgressPolicy;
  /** How long to wait for a bank before giving up (ms). */
  timeoutMs?: number;
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

  constructor(options: TransportOptions = {}) {
    this.post = options.post ?? httpPost;
    this.egress = options.egress;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Send one envelope and return the bank's body.
   *
   * A non-2xx status is a DomainError rather than a parsed response: an HTML
   * error page from a load balancer is not an EBICS answer, and treating it as
   * one produces a confusing parse failure three layers away from the cause.
   */
  async send(url: string, body: string): Promise<string> {
    if (this.egress !== undefined) {
      const verdict = await checkEgressTarget(url, this.egress);
      if (!verdict.allowed) {
        throw new DomainError(422, `refusing to send to ${url}: ${verdict.reason}`);
      }
    }

    let result: { status: number; body: string };
    try {
      result = await withTimeout(this.post(url, body), this.timeoutMs);
    } catch (err) {
      // The bank may or may not have received this. That ambiguity is the
      // caller's to resolve — see how orders.ts records `failed` rather than
      // deciding to resend.
      throw new DomainError(502, `the bank could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (result.status < 200 || result.status >= 300) {
      throw new DomainError(502, `the bank answered HTTP ${result.status}`);
    }
    return result.body;
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
