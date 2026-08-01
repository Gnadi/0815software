import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Outbound target policy — the guard on server-side request forgery.
 *
 * This service sits INSIDE the customer's stack and makes HTTP calls to URLs
 * an operator configured. That is exactly the position an attacker wants: a
 * webhook pointed at `http://ps01:4001/api/...` or at a cloud metadata
 * endpoint turns "can configure a URL" into "can reach the private network".
 *
 * So a target that resolves into a private, loopback, link-local or otherwise
 * internal range is refused. Legitimate in-stack callbacks — a workflow ringing
 * back into a module of the same deployment — stay possible through
 * `EGRESS_ALLOW_HOSTS`, which the generated stack fills in with its own
 * hostnames.
 *
 * Two deliberate limits, stated rather than hidden:
 *  - A name is resolved once, here, and then resolved again by `fetch`. A DNS
 *    entry that changes in between (rebinding) is not caught. Closing that
 *    needs the connection itself to be pinned to the checked address, which
 *    the built-in fetch does not expose.
 *  - A name that does not resolve is allowed through: there is nothing to
 *    reach, and `fetch` fails on its own a moment later. Refusing here would
 *    turn every DNS hiccup into a policy error.
 */

export type EgressMode = 'block' | 'observe' | 'off';

export interface EgressPolicy {
  /**
   * `block` refuses an internal target, `observe` only reports it, `off`
   * skips the check entirely (the default for library callers and tests).
   */
  mode: EgressMode;
  /** Hostnames — or `host:port` — that bypass the check entirely. */
  allowHosts: ReadonlySet<string>;
}

export function egressPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  return {
    mode: env.EGRESS_MODE === 'observe' ? 'observe' : env.EGRESS_MODE === 'off' ? 'off' : 'block',
    allowHosts: new Set(
      (env.EGRESS_ALLOW_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

/** The unchecked policy used where nothing is configured (tests, libraries). */
export const OPEN_EGRESS: EgressPolicy = { mode: 'off', allowHosts: new Set() };

export interface EgressVerdict {
  allowed: boolean;
  /** Why it was refused — safe to put in a delivery's `last_error`. */
  reason?: string;
}

/** Resolve a hostname to its addresses. Injectable so tests stay offline. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

const defaultResolve: ResolveHost = async (hostname) => {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((a) => a.address);
};

function ipv4IsInternal(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function ipv6IsInternal(address: string): boolean {
  const value = address.toLowerCase().split('%')[0]!; // drop any zone index
  // IPv4-mapped and IPv4-compatible forms carry a v4 address to judge.
  const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return ipv4IsInternal(mapped[1]!);
  if (value === '::' || value === '::1') return true; // unspecified, loopback
  if (/^f[cd]/.test(value)) return true; // unique local (fc00::/7)
  if (/^fe[89ab]/.test(value)) return true; // link-local (fe80::/10)
  if (/^ff/.test(value)) return true; // multicast
  return false;
}

export function addressIsInternal(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4IsInternal(address);
  if (kind === 6) return ipv6IsInternal(address);
  return true; // not an address at all — nothing we are willing to vouch for
}

/**
 * Judge one outbound URL. Never throws: a caller gets a verdict, and decides
 * whether to refuse (block mode) or merely record it (observe mode).
 */
export async function checkEgressTarget(
  rawUrl: string,
  policy: EgressPolicy,
  resolve: ResolveHost = defaultResolve,
): Promise<EgressVerdict> {
  if (policy.mode === 'off') return { allowed: true };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `not a valid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `protocol ${url.protocol} is not allowed` };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (policy.allowHosts.has(hostname) || policy.allowHosts.has(`${hostname}:${url.port}`)) {
    return { allowed: true };
  }

  // A literal address needs no lookup — and must not get one, or a resolver
  // could be talked into answering for it.
  if (isIP(hostname) !== 0) {
    return addressIsInternal(hostname)
      ? { allowed: false, reason: `${hostname} is an internal address` }
      : { allowed: true };
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { allowed: true }; // unresolvable: nothing to reach, let fetch fail
  }
  const internal = addresses.find((address) => addressIsInternal(address));
  return internal === undefined
    ? { allowed: true }
    : { allowed: false, reason: `${hostname} resolves to the internal address ${internal}` };
}

/**
 * Apply a verdict: in `block` mode an internal target is refused, in `observe`
 * mode it is only logged. Returns whether the caller may proceed.
 */
export function enforceEgress(verdict: EgressVerdict, policy: EgressPolicy, service: string, url: string): boolean {
  if (verdict.allowed) return true;
  if (policy.mode === 'observe') {
    console.warn(`[${service}] egress would be blocked (observe mode): ${url} — ${verdict.reason}`);
    return true;
  }
  return false;
}
