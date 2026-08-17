import { CATALOGUE, catalogueEntry } from '../shared/catalogue.js';
import { validateSummary, type ModuleSummary, type SummaryContext } from '../shared/summary.js';
import type { PeerMap } from './config.js';
import type { PeerStatus, PeerSummary } from '../shared/types.js';

/**
 * Talking to the modules in this stack.
 *
 * Every call here is BEST-EFFORT in the strong sense the catalogue uses: a peer
 * that is down, slow, unconfigured, or running a version that predates the
 * summary contract must cost exactly one widget. It may never fail the board,
 * and it may never make the Workspace itself unhealthy — a dashboard that goes
 * dark because one of fourteen modules is restarting would be worse than no
 * dashboard.
 *
 * That is why nothing in this file throws to its caller. A failure becomes a
 * `{ ok: false, problem }` the board renders in place, with the reason on the
 * widget, so an operator can see WHICH module is unwell without reading logs.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PeerClientOptions {
  peers: PeerMap;
  /** PLATFORM_SERVICE_TOKEN. Without it no peer will answer, by their design. */
  serviceToken?: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike;
}

/** A peer answered, but not with something we can render. */
function contractProblem(problems: { field: string; message: string }[]): string {
  const first = problems[0]!;
  return `summary did not satisfy the contract (${first.field}: ${first.message})`;
}

/**
 * Why a fetch failed, in words an operator can act on.
 *
 * Deliberately distinguishes the three cases that need different fixes: the
 * module refused us (token), the module is not answering (down or wrong URL),
 * and the module answered something else (version skew). Collapsing them into
 * "unavailable" is what makes a dashboard useless for diagnosis.
 */
function describe(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'timed out';
  if (err instanceof Error && err.name === 'AbortError') return 'timed out';
  if (err instanceof Error) return err.message;
  return 'unreachable';
}

export interface PeerClient {
  /** Which modules are configured, embeddable, and where their public origin is. */
  statuses(): PeerStatus[];
  /** Is this module in the stack at all? */
  has(moduleId: string): boolean;
  /** The public origin a browser should use for this module, if any. */
  publicUrl(moduleId: string): string | null;
  /** One peer's summary under the given context. Never throws. */
  summary(moduleId: string, context: SummaryContext): Promise<PeerSummary>;
  /** Every configured peer's summary, concurrently. Never throws. */
  summaries(context: SummaryContext): Promise<PeerSummary[]>;
  /** Ask a peer for a single-use handoff ticket for `actor`. Never throws. */
  handoff(moduleId: string, actor: string, path: string): Promise<{ ok: true; url: string } | { ok: false; problem: string }>;
  /** Ask a peer for a replayable session for `actor`. Never throws. */
  issueSession(moduleId: string, actor: string): Promise<{ ok: true; cookie: string } | { ok: false; problem: string }>;
  /** Call a peer route as `actor`, replaying a session cookie. Never throws. */
  callAs(
    moduleId: string,
    cookie: string,
    path: string,
    init: RequestInit,
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; problem: string }>;
}

export function createPeerClient(options: PeerClientOptions): PeerClient {
  const { peers, serviceToken, timeoutMs } = options;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function call(
    moduleId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; problem: string }> {
    const peer = peers[moduleId];
    if (!peer) return { ok: false, problem: 'not in this stack' };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is enforced HERE, not only through the abort signal.
    //
    // Aborting is the polite half: it tells the transport to stop and frees the
    // socket. But it only bounds the wait if whatever implements `fetch`
    // actually honours the signal, and "one sick module costs one widget" is
    // the property this whole file exists to keep — too important to delegate
    // to a promise that might never settle. So the abort is fired AND the wait
    // is raced, and the board moves on either way.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const err = new Error('timed out');
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
    });

    try {
      const res = await Promise.race([doFetch(`${peer.url}${path}`, { ...init, signal: controller.signal }), deadline]);
      // A body that is not JSON is a peer answering something other than its
      // API — a proxy error page, most often — and saying so beats "undefined".
      let body: unknown = null;
      // Reading the body is also bounded: a peer that sends headers and then
      // stalls mid-body would otherwise hang here, past the deadline above.
      const text = await Promise.race([res.text(), deadline]);
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          return { ok: false, problem: `answered ${res.status} with a non-JSON body` };
        }
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      return { ok: false, problem: describe(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // A rejected `deadline` nobody is awaiting any more would surface as an
      // unhandled rejection and, under Node's default, take the process down —
      // a peer timeout must not be able to do that.
      deadline.catch(() => undefined);
    }
  }

  function machineHeaders(): Record<string, string> {
    return serviceToken ? { 'X-Service-Token': serviceToken, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  }

  return {
    statuses(): PeerStatus[] {
      return CATALOGUE.map((entry) => {
        const peer = peers[entry.id];
        return {
          id: entry.id,
          n: entry.n,
          label: entry.label,
          configured: peer !== undefined,
          // A module that cannot be framed, or that has no browser-reachable
          // origin, is not embeddable in this deployment however capable it is
          // in principle. The board must not offer a frame it cannot fill.
          embeddable: entry.embeddable && peer?.publicUrl != null,
          publicUrl: peer?.publicUrl ?? null,
          reachable: null,
          problem: null,
        };
      });
    },

    has(moduleId: string): boolean {
      return peers[moduleId] !== undefined;
    },

    publicUrl(moduleId: string): string | null {
      return peers[moduleId]?.publicUrl ?? null;
    },

    async summary(moduleId: string, context: SummaryContext): Promise<PeerSummary> {
      if (!serviceToken) {
        return { ok: false, module: moduleId, problem: 'no PLATFORM_SERVICE_TOKEN is configured for this stack' };
      }
      const query = new URLSearchParams();
      if (context.party !== undefined) query.set('party', String(context.party));
      if (context.from !== undefined) query.set('from', context.from);
      if (context.to !== undefined) query.set('to', context.to);
      const suffix = query.toString() ? `?${query.toString()}` : '';

      const res = await call(moduleId, `/api/summary${suffix}`, { headers: machineHeaders() });
      if (!res.ok) return { ok: false, module: moduleId, problem: res.problem };
      if (res.status === 401) return { ok: false, module: moduleId, problem: 'refused the stack’s service token' };
      if (res.status === 404) {
        // The honest reading of a 404 here: this module is older than the
        // summary contract. Naming that is more useful than "not found",
        // because the fix is an upgrade rather than a config change.
        return { ok: false, module: moduleId, problem: 'does not serve a summary (upgrade the module)' };
      }
      if (res.status !== 200) return { ok: false, module: moduleId, problem: `answered ${res.status}` };

      const problems = validateSummary(res.body);
      if (problems.length > 0) return { ok: false, module: moduleId, problem: contractProblem(problems) };

      const summary = res.body as ModuleSummary;
      // A peer claiming to be a different module would put its widgets on the
      // wrong tile and its links on the wrong origin.
      if (summary.module !== moduleId) {
        return { ok: false, module: moduleId, problem: `identified itself as ${summary.module}` };
      }
      return { ok: true, module: moduleId, summary };
    },

    async summaries(context: SummaryContext): Promise<PeerSummary[]> {
      // Concurrent on purpose: the board's latency is its slowest peer, not the
      // sum of fourteen. `allSettled` is belt and braces — `summary` already
      // resolves rather than rejects — so one unforeseen throw cannot take the
      // whole board down.
      const configured = CATALOGUE.filter((entry) => peers[entry.id] !== undefined);
      const results = await Promise.allSettled(configured.map((entry) => this.summary(entry.id, context)));
      return results.map((result, i) =>
        result.status === 'fulfilled'
          ? result.value
          : { ok: false as const, module: configured[i]!.id, problem: describe(result.reason) },
      );
    },

    async handoff(moduleId: string, actor: string, path: string) {
      const entry = catalogueEntry(moduleId);
      const publicUrl = peers[moduleId]?.publicUrl ?? null;
      if (!entry?.embeddable) return { ok: false as const, problem: 'this module cannot be embedded' };
      if (!publicUrl) return { ok: false as const, problem: 'no public URL is configured for this module' };
      if (!serviceToken) return { ok: false as const, problem: 'no PLATFORM_SERVICE_TOKEN is configured for this stack' };

      const res = await call(moduleId, '/api/session/handoff', {
        method: 'POST',
        headers: machineHeaders(),
        body: JSON.stringify({ actor, path }),
      });
      if (!res.ok) return { ok: false as const, problem: res.problem };
      if (res.status !== 200) {
        return { ok: false as const, problem: res.status === 401 ? 'is not configured to accept this shell' : `answered ${res.status}` };
      }
      const redeem = (res.body as { redeem_path?: unknown }).redeem_path;
      if (typeof redeem !== 'string' || !redeem.startsWith('/')) {
        return { ok: false as const, problem: 'returned no usable redemption path' };
      }
      // Joined here, on the PUBLIC origin: the browser is what follows this.
      return { ok: true as const, url: `${publicUrl}${redeem}` };
    },

    async issueSession(moduleId: string, actor: string) {
      if (!serviceToken) return { ok: false as const, problem: 'no PLATFORM_SERVICE_TOKEN is configured for this stack' };
      const res = await call(moduleId, '/api/session/issue', {
        method: 'POST',
        headers: machineHeaders(),
        body: JSON.stringify({ actor }),
      });
      if (!res.ok) return { ok: false as const, problem: res.problem };
      if (res.status !== 200) {
        return { ok: false as const, problem: res.status === 401 ? 'is not configured to accept this shell' : `answered ${res.status}` };
      }
      const { cookie_name: name, token } = res.body as { cookie_name?: unknown; token?: unknown };
      if (typeof name !== 'string' || typeof token !== 'string') {
        return { ok: false as const, problem: 'returned no usable session' };
      }
      return { ok: true as const, cookie: `${name}=${token}` };
    },

    callAs(moduleId: string, cookie: string, path: string, init: RequestInit) {
      return call(moduleId, path, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookie, 'Content-Type': 'application/json' },
      });
    },
  };
}
