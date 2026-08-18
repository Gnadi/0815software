import { CATALOGUE, catalogueEntry } from '../shared/catalogue.js';
import type { PeerConfig, PeerMap } from './config.js';
import type { PeerStatus } from '../shared/types.js';

/**
 * Talking to the modules in this stack.
 *
 * There is exactly one thing to ask them: mint a single-use ticket so a frame
 * can open already signed in. No figures are fetched, because this shell shows
 * no figures — it shows the modules.
 *
 * Every call is BEST-EFFORT in the strong sense the catalogue uses: a peer that
 * is down or unconfigured must cost exactly one pane. It may never fail the
 * board, and it may never make this module unhealthy — a screen that goes dark
 * because one of a dozen modules is restarting would be worse than no screen.
 *
 * That is why nothing here throws to its caller. A failure becomes a
 * `{ ok: false, problem }` the board renders in the pane's place, with the
 * reason on it, so an operator sees WHICH module is unwell without reading logs.
 */

/**
 * A peer by id, or undefined — never something inherited from Object.prototype.
 *
 * `peers[id]` is a plain-object lookup, so `peers['__proto__']`,
 * `peers['constructor']` and `peers['toString']` all answer with something
 * truthy for a stack that contains none of them. Module ids reach these
 * functions from a URL (`/api/embed/:moduleId`), and while the catalogue check
 * happens to refuse those three today, a lookup that can return a function
 * where a config was expected is the kind of trap that stays quiet until some
 * later caller checks it in a different order. This repo has paid for that once
 * already (`f96129b`, templates reaching Object.prototype).
 */
function peerOf(peers: PeerMap, moduleId: string): PeerConfig | undefined {
  return Object.hasOwn(peers, moduleId) ? peers[moduleId] : undefined;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PeerClientOptions {
  peers: PeerMap;
  /** PLATFORM_SERVICE_TOKEN. Without it no peer will answer, by their design. */
  serviceToken?: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike;
}

/**
 * The most a peer may say in one answer.
 *
 * The summary contract already caps tiles, lists and rows, but that check runs
 * on a PARSED body — by which point an enormous one has already been read into
 * this process and handed to `JSON.parse`. This is the limit before that: 1 MiB
 * is orders of magnitude above a real summary (MOD-13's is under 4 KiB) and
 * comfortably below anything that hurts.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Sentinel for a body that ran past the cap — distinct from any real body. */
const TOO_LARGE = Symbol('too-large');

/**
 * Read a response body, stopping at `MAX_RESPONSE_BYTES`.
 *
 * `res.text()` would read whatever arrives, however much that is. This reads
 * the stream instead and aborts the request the moment the limit is passed, so
 * the bytes already sent are the only ones this process ever holds.
 *
 * A body-less response (204, or a HEAD) has no stream; that is an empty string,
 * not an error.
 */
async function readCapped(res: Response, controller: AbortController): Promise<string | typeof TOO_LARGE> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
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
  /** Ask a peer for a single-use handoff ticket for `actor`. Never throws. */
  handoff(moduleId: string, actor: string, path: string): Promise<{ ok: true; url: string } | { ok: false; problem: string }>;
}

export function createPeerClient(options: PeerClientOptions): PeerClient {
  const { peers, serviceToken, timeoutMs } = options;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function call(
    moduleId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; problem: string }> {
    const peer = peerOf(peers, moduleId);
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
      // Reading the body is bounded two ways. By TIME, because a peer that
      // sends headers and then stalls would otherwise hang past the deadline
      // above. And by SIZE, because the deadline does not bound a peer that
      // answers quickly and enormously: a mistyped URL pointing at a file
      // server, or a module with a runaway query, would be read into memory in
      // full and only then rejected. `readCapped` stops at the limit.
      const text = await Promise.race([readCapped(res, controller), deadline]);
      if (text === TOO_LARGE) {
        return { ok: false, problem: `answered with more than ${MAX_RESPONSE_BYTES / 1024} KiB` };
      }
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

  const client: PeerClient = {
    statuses(): PeerStatus[] {
      return CATALOGUE.map((entry) => {
        const peer = peerOf(peers, entry.id);
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
        };
      });
    },

    has(moduleId: string): boolean {
      return peerOf(peers, moduleId) !== undefined;
    },

    publicUrl(moduleId: string): string | null {
      return peerOf(peers, moduleId)?.publicUrl ?? null;
    },

    async handoff(moduleId: string, actor: string, path: string) {
      const entry = catalogueEntry(moduleId);
      const publicUrl = peerOf(peers, moduleId)?.publicUrl ?? null;
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

  };

  return client;
}
