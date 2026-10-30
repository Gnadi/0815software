import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { Duplex } from 'node:stream';

/**
 * A small IMAP4rev1 client (RFC 3501) — exactly what a mailbox bridge needs
 * and nothing more: log in, select one folder, list the unread messages,
 * fetch them without marking them read (BODY.PEEK), and mark them read once
 * the consumer has them. Node built-ins only.
 *
 * Read and acknowledge are separate calls on purpose. A message is flagged
 * \Seen only after the consumer says it stored it; should anything fail in
 * between, the message is still unread and comes back on the next fetch —
 * and the consumer recognises it by its Message-ID. Nothing is lost, nothing
 * is taken twice.
 *
 * Transport is TLS from the first byte (port 993) or STARTTLS (port 143);
 * a plaintext session would send the password in the clear, so there is none.
 */

export type MailSecurity = 'tls' | 'starttls';

export interface MailboxTarget {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  password: string;
  mailbox: string;
}

/** How a socket is opened — injectable so tests can trust their own certificate. */
export interface MailTransport {
  /** Open a connection to `address` (already checked), naming `host` for TLS. */
  open(target: { host: string; address: string; port: number; tls: boolean; timeoutMs: number }): Promise<Duplex>;
  /** Upgrade a plaintext socket after STARTTLS. */
  upgrade(socket: Duplex, host: string): Promise<Duplex>;
}

export interface ImapLimits {
  timeoutMs: number;
  /** A larger message is fetched as headers only. */
  maxMessageBytes: number;
  /** What one fetch may return in total; the rest waits for the next one. */
  maxFetchBytes: number;
}

export const DEFAULT_IMAP_LIMITS: ImapLimits = { timeoutMs: 30_000, maxMessageBytes: 10 * 1024 * 1024, maxFetchBytes: 25 * 1024 * 1024 };

/** The server said NO or BAD, or the session broke. `auth` marks a refused login. */
export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'protocol' | 'network' | 'state' = 'protocol',
  ) {
    super(message);
    this.name = 'ImapError';
  }
}

export function defaultMailTransport(tls: Pick<ConnectionOptions, 'ca'> = {}): MailTransport {
  const tlsOptions = (host: string): ConnectionOptions => ({
    ...tls,
    // SNI and certificate checks are against the NAME, while the socket goes
    // to the address the egress check approved (no second DNS lookup).
    servername: isIP(host) === 0 ? host : undefined,
    minVersion: 'TLSv1.2',
  });
  const settle = (socket: Duplex & { setTimeout(ms: number): unknown }, event: string, timeoutMs?: number): Promise<Duplex> =>
    new Promise((resolve, reject) => {
      // A host that drops packets would otherwise hold the request for the
      // operating system's connect timeout, minutes long.
      if (timeoutMs !== undefined) {
        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => socket.destroy(new Error('connection timed out')));
      }
      socket.once(event, () => resolve(socket));
      socket.once('error', (err) => reject(new ImapError(`Cannot reach the mailbox: ${(err as Error).message}`, 'network')));
    });
  return {
    open({ host, address, port, tls: secure, timeoutMs }) {
      if (secure) return settle(tlsConnect({ host: address, port, ...tlsOptions(host) }), 'secureConnect', timeoutMs);
      return settle(netConnect({ host: address, port }), 'connect', timeoutMs);
    },
    upgrade(socket, host) {
      return settle(tlsConnect({ socket, ...tlsOptions(host) }), 'secureConnect');
    },
  };
}

interface Response {
  /** The response line(s), each literal replaced by \u0000<n>\u0000. */
  text: string;
  literals: Buffer[];
}

/** Quote a string for a command, or pass it as a literal when quoting cannot carry it. */
type Arg = string | { literal: Buffer };

function astring(value: string): Arg {
  // Printable ASCII travels as a quoted string; anything else (UTF-8
  // passwords included) as a literal, which carries any octets.
  return /^[\x20-\x7e]*$/.test(value) ? `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"` : { literal: Buffer.from(value, 'utf8') };
}

class Session {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: { resolve: (r: Response) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private tag = 0;
  private socket: Duplex;
  private detach: () => void = () => undefined;

  constructor(
    socket: Duplex,
    private readonly limits: ImapLimits,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Duplex): void {
    const onData = (chunk: Buffer): void => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      // A server streaming without end is an attack on memory, not mail.
      if (this.buffer.length > this.limits.maxFetchBytes + 1024 * 1024) this.fail(new ImapError('The mailbox sent more than the fetch limit', 'protocol'));
      this.pump();
    };
    const onError = (err: Error): void => this.fail(new ImapError(`Mailbox connection failed: ${err.message}`, 'network'));
    const onClose = (): void => this.fail(new ImapError('The mailbox closed the connection', 'network'));
    const onTimeout = (): void => {
      this.fail(new ImapError('The mailbox did not answer in time', 'network'));
      socket.destroy();
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    const timed = socket as Duplex & { setTimeout?: (ms: number) => unknown };
    timed.setTimeout?.(this.limits.timeoutMs);
    // Only our own listeners: the TLS layer that takes the socket over after
    // STARTTLS relies on the ones Node put there.
    this.detach = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
      timed.setTimeout?.(0);
    };
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    const p = this.pending;
    this.pending = null;
    p?.reject(this.failure);
  }

  /** One complete response — a line and the literals embedded in it. */
  private parse(): Response | null {
    let text = '';
    const literals: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const eol = this.buffer.indexOf('\r\n', offset);
      if (eol < 0) return null;
      const line = this.buffer.subarray(offset, eol).toString('latin1');
      const literal = /\{(\d+)\}$/.exec(line);
      if (literal) {
        const size = Number(literal[1]);
        const start = eol + 2;
        if (this.buffer.length < start + size) return null;
        text += `${line.slice(0, -literal[0].length)}\u0000${literals.length}\u0000`;
        literals.push(Buffer.from(this.buffer.subarray(start, start + size)));
        offset = start + size;
        continue;
      }
      text += line;
      this.buffer = this.buffer.subarray(eol + 2);
      return { text, literals };
    }
  }

  private pump(): void {
    if (!this.pending) return;
    const r = this.parse();
    if (!r) return;
    const p = this.pending;
    this.pending = null;
    p.resolve(r);
  }

  next(): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure);
    const ready = this.parse();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private write(data: string | Buffer): void {
    this.socket.write(data);
  }

  /** Send a tagged command; returns the untagged responses. NO/BAD throws. */
  async command(name: string, args: Arg[] = []): Promise<Response[]> {
    const tag = `A${++this.tag}`;
    let line = `${tag} ${name}`;
    for (const arg of args) {
      if (typeof arg === 'string') {
        line += ` ${arg}`;
        continue;
      }
      this.write(`${line} {${arg.literal.length}}\r\n`);
      const go = await this.next();
      if (!go.text.startsWith('+')) throw new ImapError(`The mailbox refused a literal: ${go.text}`, 'protocol');
      this.write(arg.literal);
      line = '';
    }
    this.write(`${line}\r\n`);
    const untagged: Response[] = [];
    for (;;) {
      const r = await this.next();
      if (r.text.startsWith(`${tag} `)) {
        const status = r.text.slice(tag.length + 1);
        if (/^OK\b/i.test(status)) return untagged;
        throw new ImapError(`${name.split(' ')[0]} failed: ${status}`, name === 'LOGIN' ? 'auth' : 'protocol');
      }
      untagged.push(r);
    }
  }

  async upgrade(transport: MailTransport, host: string): Promise<void> {
    this.detach();
    this.socket = await transport.upgrade(this.socket, host);
    this.attach(this.socket);
  }

  close(): void {
    this.socket.destroy();
  }
}

// ── Parsing untagged responses ───────────────────────────────────────

type Token = string | Buffer | null | Token[];

/** Tokenize a parenthesised IMAP value list: atoms, quoted strings, literals, NIL, nested lists. */
function tokenize(text: string, literals: Buffer[]): Token[] {
  let i = 0;
  const list = (): Token[] => {
    const out: Token[] = [];
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === ' ') {
        i++;
      } else if (ch === '(') {
        i++;
        out.push(list());
      } else if (ch === ')') {
        i++;
        return out;
      } else if (ch === '"') {
        let s = '';
        i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') i++;
          s += text[i++];
        }
        i++;
        out.push(s);
      } else if (ch === '\u0000') {
        const end = text.indexOf('\u0000', i + 1);
        out.push(literals[Number(text.slice(i + 1, end))]!);
        i = end + 1;
      } else {
        let s = '';
        // An atom may carry a section in brackets — BODY[HEADER] — kept whole.
        while (i < text.length && !' ()"\u0000'.includes(text[i]!)) {
          if (text[i] === '[') {
            const close = text.indexOf(']', i);
            s += text.slice(i, close + 1);
            i = close + 1;
          } else s += text[i++];
        }
        out.push(s.toUpperCase() === 'NIL' ? null : s);
      }
    }
    return out;
  };
  return list();
}

interface FetchItem {
  uid: number;
  size?: number;
  body?: Buffer;
}

function fetchItems(responses: Response[]): FetchItem[] {
  const items: FetchItem[] = [];
  for (const r of responses) {
    const m = /^\* \d+ FETCH /i.exec(r.text);
    if (!m) continue;
    const [values] = tokenize(r.text.slice(m[0].length), r.literals) as [Token[]];
    if (!Array.isArray(values)) continue;
    const item: Partial<FetchItem> = {};
    for (let k = 0; k + 1 < values.length; k += 2) {
      const key = String(values[k]).toUpperCase();
      const value = values[k + 1];
      if (key === 'UID') item.uid = Number(value);
      else if (key === 'RFC822.SIZE') item.size = Number(value);
      else if (key.startsWith('BODY[')) item.body = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.alloc(0);
    }
    if (item.uid !== undefined && Number.isInteger(item.uid)) items.push(item as FetchItem);
  }
  return items;
}

function searchUids(responses: Response[]): number[] {
  const uids: number[] = [];
  for (const r of responses) {
    const m = /^\* SEARCH\b(.*)$/i.exec(r.text);
    if (m) for (const n of m[1]!.trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.push(Number(n));
  }
  return uids.sort((a, b) => a - b);
}

interface Selected {
  uidvalidity: number;
  exists: number;
}

function selected(responses: Response[]): Selected {
  let uidvalidity = 0;
  let exists = 0;
  for (const r of responses) {
    const v = /\[UIDVALIDITY (\d+)\]/i.exec(r.text);
    if (v) uidvalidity = Number(v[1]);
    const e = /^\* (\d+) EXISTS/i.exec(r.text);
    if (e) exists = Number(e[1]);
  }
  return { uidvalidity, exists };
}

const uidSet = (uids: number[]): string => uids.join(',');

// ── Sessions ─────────────────────────────────────────────────────────

async function withMailbox<T>(
  target: MailboxTarget,
  address: string,
  transport: MailTransport,
  limits: ImapLimits,
  run: (session: Session, box: Selected) => Promise<T>,
): Promise<T> {
  const socket = await transport.open({ host: target.host, address, port: target.port, tls: target.security === 'tls', timeoutMs: limits.timeoutMs });
  const session = new Session(socket, limits);
  try {
    const greeting = await session.next();
    if (/^\* BYE/i.test(greeting.text)) throw new ImapError(`The mailbox turned the connection away: ${greeting.text}`, 'network');
    if (target.security === 'starttls') {
      await session.command('STARTTLS');
      await session.upgrade(transport, target.host);
    }
    if (!/^\* PREAUTH/i.test(greeting.text)) {
      await session.command('LOGIN', [astring(target.username), astring(target.password)]);
    }
    const box = selected(await session.command('SELECT', [astring(target.mailbox)]));
    const result = await run(session, box);
    await session.command('LOGOUT').catch(() => undefined);
    return result;
  } finally {
    session.close();
  }
}

export interface MailboxProbe {
  uidvalidity: number;
  exists: number;
  unseen: number;
}

export interface FetchedMessage {
  uid: number;
  size: number;
  raw: Buffer;
  /** Larger than the per-message limit: `raw` holds the headers only. */
  headersOnly: boolean;
}

export interface FetchResult {
  uidvalidity: number;
  messages: FetchedMessage[];
  /** Unread messages left for a later fetch. */
  remaining: number;
}

export function probeMailbox(target: MailboxTarget, address: string, transport: MailTransport, limits = DEFAULT_IMAP_LIMITS): Promise<MailboxProbe> {
  return withMailbox(target, address, transport, limits, async (session, box) => {
    const unseen = searchUids(await session.command('UID SEARCH UNSEEN')).length;
    return { uidvalidity: box.uidvalidity, exists: box.exists, unseen };
  });
}

/** The oldest unread messages, without marking them read, within the size limits. */
export function fetchUnseen(target: MailboxTarget, address: string, transport: MailTransport, limit: number, limits = DEFAULT_IMAP_LIMITS): Promise<FetchResult> {
  return withMailbox(target, address, transport, limits, async (session, box) => {
    const unseen = searchUids(await session.command('UID SEARCH UNSEEN'));
    const candidates = unseen.slice(0, limit);
    if (candidates.length === 0) return { uidvalidity: box.uidvalidity, messages: [], remaining: 0 };
    const sizes = new Map(fetchItems(await session.command(`UID FETCH ${uidSet(candidates)} (UID RFC822.SIZE)`)).map((i) => [i.uid, i.size ?? 0]));
    const whole: number[] = [];
    const headers: number[] = [];
    let total = 0;
    for (const uid of candidates) {
      const size = sizes.get(uid);
      if (size === undefined) continue; // vanished in between
      const cost = size > limits.maxMessageBytes ? 0 : size;
      // The first message always goes, or one large mail would block the box.
      if (whole.length + headers.length > 0 && total + cost > limits.maxFetchBytes) break;
      total += cost;
      (size > limits.maxMessageBytes ? headers : whole).push(uid);
    }
    const bodies = new Map<number, Buffer>();
    if (whole.length > 0) for (const i of fetchItems(await session.command(`UID FETCH ${uidSet(whole)} (UID BODY.PEEK[])`))) if (i.body) bodies.set(i.uid, i.body);
    const heads = new Map<number, Buffer>();
    if (headers.length > 0) for (const i of fetchItems(await session.command(`UID FETCH ${uidSet(headers)} (UID BODY.PEEK[HEADER])`))) if (i.body) heads.set(i.uid, i.body);
    const messages: FetchedMessage[] = [];
    for (const uid of [...whole, ...headers].sort((a, b) => a - b)) {
      const raw = bodies.get(uid) ?? heads.get(uid);
      if (raw) messages.push({ uid, size: sizes.get(uid) ?? raw.length, raw, headersOnly: heads.has(uid) });
    }
    return { uidvalidity: box.uidvalidity, messages, remaining: unseen.length - messages.length };
  });
}

/**
 * Mark messages read. UIDs only mean something within one UIDVALIDITY: if the
 * folder was rebuilt since the fetch, the same numbers name other messages, so
 * nothing is marked and the caller is told.
 */
export function markSeen(target: MailboxTarget, address: string, transport: MailTransport, uidvalidity: number, uids: number[], limits = DEFAULT_IMAP_LIMITS): Promise<number> {
  return withMailbox(target, address, transport, limits, async (session, box) => {
    if (box.uidvalidity !== uidvalidity) throw new ImapError(`The mailbox changed since the fetch (UIDVALIDITY ${box.uidvalidity}, expected ${uidvalidity})`, 'state');
    if (uids.length === 0) return 0;
    await session.command(`UID STORE ${uidSet(uids)} +FLAGS.SILENT (\\Seen)`);
    return uids.length;
  });
}
