/**
 * Internet message parsing — RFC 5322 headers, MIME (RFC 2045/2046), encoded
 * words in headers (RFC 2047) and encoded parameters (RFC 2231). Node
 * built-ins only.
 *
 * It turns one raw message into what a consumer can act on: who wrote it, the
 * subject, the threading headers, the readable text, the attachments, and
 * whether a machine sent it. It does not render HTML, verify signatures or
 * decrypt — a signed message's signature is simply one more attachment.
 *
 * Bytes are handled as latin1 strings while splitting (one char per byte, so
 * nothing is lost) and decoded with the declared charset only at the end: a
 * multi-byte character split across encoded words, or across base64 lines,
 * is reassembled before it is decoded.
 */

export interface MailAddress {
  name: string | null;
  address: string;
}

export interface ParsedAttachment {
  filename: string;
  content_type: string;
  /** Shown inside the message (an embedded image) rather than attached to it. */
  inline: boolean;
  content_id: string | null;
  content: Buffer;
}

export interface ParsedMessage {
  message_id: string | null;
  from: MailAddress | null;
  reply_to: MailAddress | null;
  to: MailAddress[];
  subject: string;
  date: string | null;
  in_reply_to: string | null;
  references: string[];
  text: string;
  /** Why the message looks machine-sent (RFC 3834 and common practice), or null. */
  automated: string | null;
  attachments: ParsedAttachment[];
}

type Headers = Map<string, string[]>;

interface Part {
  headers: Headers;
  /** Raw body bytes as a latin1 string. */
  body: string;
}

// ── Charsets ─────────────────────────────────────────────────────────

/**
 * windows-1252's 0x80–0x9F. Node's TextDecoder treats that label as plain
 * latin1 and hands back C1 control characters, so the euro sign and typographic
 * quotes Outlook writes would turn into garbage. Mail clients read
 * iso-8859-1 as windows-1252 too (as the WHATWG encoding standard does).
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const CP1252_LABELS = new Set(['us-ascii', 'ascii', 'iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'l1', 'windows-1252', 'cp1252', 'cp819', 'ibm819', 'iso_8859-1']);

function decodeCp1252(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b);
  return out;
}

/** Decode bytes in a declared charset; an unknown label falls back to UTF-8, never to an error. */
export function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (CP1252_LABELS.has(label)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(label === 'utf8' ? 'utf-8' : label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Header bytes: UTF-8 when they are valid UTF-8 (RFC 6532), windows-1252 otherwise. */
function decodeRawHeader(latin1: string): string {
  const bytes = Buffer.from(latin1, 'latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

// ── RFC 2047 encoded words ───────────────────────────────────────────

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

function wordBytes(encoding: string, text: string): Buffer {
  if (encoding.toUpperCase() === 'B') return Buffer.from(text, 'base64');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '_') bytes.push(0x20);
    else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * Decode the encoded words in a header value. Whitespace between two
 * adjacent encoded words is dropped (RFC 2047 §6.2), and adjacent words in
 * the same charset are joined as bytes before decoding, so a UTF-8 character
 * split between two words survives.
 */
export function decodeEncodedWords(value: string): string {
  const pieces: { kind: 'text' | 'word'; text: string; charset?: string; bytes?: Buffer }[] = [];
  let last = 0;
  for (const m of value.matchAll(ENCODED_WORD)) {
    if (m.index > last) pieces.push({ kind: 'text', text: value.slice(last, m.index) });
    // RFC 2231 §5 lets a language ride on the charset: "US-ASCII*EN".
    pieces.push({ kind: 'word', text: m[0], charset: m[1]!.split('*')[0]!.toLowerCase(), bytes: wordBytes(m[2]!, m[3]!) });
    last = m.index + m[0].length;
  }
  if (last < value.length) pieces.push({ kind: 'text', text: value.slice(last) });

  let out = '';
  let run: { charset: string; bytes: Buffer[] } | null = null;
  const flush = (): void => {
    if (run) out += decodeCharset(Buffer.concat(run.bytes), run.charset);
    run = null;
  };
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.kind === 'word') {
      if (run && run.charset === p.charset) run.bytes.push(p.bytes!);
      else {
        flush();
        run = { charset: p.charset!, bytes: [p.bytes!] };
      }
      continue;
    }
    const between = pieces[i - 1]?.kind === 'word' && pieces[i + 1]?.kind === 'word' && /^[ \t\r\n]*$/.test(p.text);
    if (between) continue;
    flush();
    out += p.text;
  }
  flush();
  return out;
}

// ── Headers and parameters ───────────────────────────────────────────

function splitHeaderBody(raw: string): { head: string; body: string } {
  // A part may have no headers at all: it then starts with the blank line.
  if (raw.startsWith('\r\n')) return { head: '', body: raw.slice(2) };
  if (raw.startsWith('\n')) return { head: '', body: raw.slice(1) };
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return { head: raw, body: '' };
  if (lf < 0 || (crlf >= 0 && crlf < lf)) return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
}

function parseHeaders(head: string): Headers {
  const headers: Headers = new Map();
  // Unfold: a line break followed by whitespace continues the field (RFC 5322 §2.2.3).
  const unfolded = head.replace(/\r?\n(?=[ \t])/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = decodeRawHeader(line.slice(colon + 1)).trim();
    const list = headers.get(name) ?? [];
    list.push(value);
    headers.set(name, list);
  }
  return headers;
}

function header(headers: Headers, name: string): string | null {
  return headers.get(name)?.[0] ?? null;
}

/** Split on `;` outside quoted strings. */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted && ch === '\\' && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

function unquote(value: string): string {
  const v = value.trim();
  return v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v;
}

function percentBytes(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * A structured header value — `text/plain; charset="utf-8"` — with its
 * parameters, RFC 2231 continuations (`name*0*=`, `name*1=`) and charset
 * encoding (`name*=utf-8''%C3%A4`) put back together.
 */
export function parseParameterized(value: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = splitParams(value);
  const segments = new Map<string, { index: number; encoded: boolean; text: string }[]>();
  const plain: Record<string, string> = {};
  for (const raw of rest) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const name = raw.slice(0, eq).trim().toLowerCase();
    const text = unquote(raw.slice(eq + 1));
    const m = /^([^*]+)\*(?:(\d+)\*?|)$/.exec(name);
    if (m && name.includes('*')) {
      const base = m[1]!;
      const index = m[2] === undefined ? 0 : Number(m[2]);
      const encoded = name.endsWith('*');
      const list = segments.get(base) ?? [];
      list.push({ index, encoded, text });
      segments.set(base, list);
    } else plain[name] = decodeEncodedWords(text);
  }
  const params: Record<string, string> = { ...plain };
  for (const [base, list] of segments) {
    list.sort((a, b) => a.index - b.index);
    let charset = 'us-ascii';
    const bytes: Buffer[] = [];
    list.forEach((seg, i) => {
      let text = seg.text;
      if (seg.encoded && i === 0) {
        // charset'language'value — either part may be empty.
        const parts = text.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || charset;
          text = parts.slice(2).join("'");
        }
      }
      bytes.push(seg.encoded ? percentBytes(text) : Buffer.from(text, 'utf8'));
    });
    params[base] = decodeCharset(Buffer.concat(bytes), charset);
  }
  return { value: (first ?? '').trim().toLowerCase(), params };
}

// ── Addresses, ids, dates ────────────────────────────────────────────

/** Split an address list on commas outside quotes, angle brackets and comments. */
function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted && ch === '\\') {
      current += ch + (value[++i] ?? '');
      continue;
    }
    if (ch === '"' && comment === 0) quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && ch === '(') comment++;
    else if (!quoted && ch === ')') comment = Math.max(0, comment - 1);
    if (ch === ',' && !quoted && angle === 0 && comment === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseAddress(value: string): MailAddress | null {
  const angle = /<([^<>]*)>\s*$/.exec(value);
  if (angle) {
    const address = angle[1]!.trim();
    if (!address.includes('@')) return null;
    const name = decodeEncodedWords(unquote(value.slice(0, angle.index).trim())).trim();
    return { name: name === '' ? null : name, address: address.toLowerCase() };
  }
  // addr-spec, perhaps with an old-style comment: "jdoe@example.org (John Doe)"
  const m = /^\s*([^\s()<>]+@[^\s()<>]+)\s*(?:\((.*)\))?\s*$/.exec(value);
  if (!m) return null;
  return { name: m[2] ? decodeEncodedWords(m[2]).trim() || null : null, address: m[1]!.toLowerCase() };
}

export function parseAddressList(value: string | null): MailAddress[] {
  if (!value) return [];
  return splitAddresses(value)
    .map(parseAddress)
    .filter((a): a is MailAddress => a !== null);
}

/** Message ids without their angle brackets, in order. */
export function parseMessageIds(value: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

// ── Bodies ───────────────────────────────────────────────────────────

/** Quoted-printable (RFC 2045 §6.7): trailing whitespace dropped, soft breaks joined, =XX decoded. */
export function decodeQuotedPrintable(latin1: string): Buffer {
  const text = latin1.replace(/[ \t]+(?=\r?\n|$)/g, '').replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBody(part: Part): Buffer {
  const encoding = (header(part.headers, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  if (encoding === 'base64') return Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(part.body);
  return Buffer.from(part.body, 'latin1');
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', euro: '€', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', hellip: '…', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®',
};

/** Readable text from an HTML body — used only when a message has no text/plain alternative. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name] ?? whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The parts of a multipart body (RFC 2046 §5.1.1): preamble and epilogue dropped. */
export function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const isDelimiterAt = (at: number): boolean => {
    if (!body.startsWith(delimiter, at)) return false;
    const after = body[at + delimiter.length];
    return after === undefined || after === '-' || after === '\r' || after === '\n' || after === ' ' || after === '\t';
  };
  const findFrom = (from: number): number => {
    if (isDelimiterAt(from)) return from;
    let i = from;
    for (;;) {
      const hit = body.indexOf(`\n${delimiter}`, i);
      if (hit < 0) return -1;
      if (isDelimiterAt(hit + 1)) return hit + 1;
      i = hit + 1;
    }
  };
  const parts: string[] = [];
  let at = findFrom(0);
  while (at >= 0) {
    const after = at + delimiter.length;
    if (body.startsWith('--', after)) break; // the close delimiter
    const eol = body.indexOf('\n', after);
    if (eol < 0) break;
    const start = eol + 1;
    const next = findFrom(start);
    if (next < 0) {
      // No close delimiter: a truncated message still yields what it has.
      parts.push(body.slice(start));
      break;
    }
    // The line break before a delimiter belongs to the delimiter.
    let end = next - 1;
    if (body[end - 1] === '\r') end--;
    parts.push(body.slice(start, Math.max(start, end)));
    at = next;
  }
  return parts;
}

function parsePart(raw: string): Part {
  const { head, body } = splitHeaderBody(raw);
  return { headers: parseHeaders(head), body };
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'text/plain': 'txt',
  'text/html': 'html', 'message/rfc822': 'eml', 'text/calendar': 'ics', 'application/zip': 'zip',
};

interface Collected {
  texts: string[];
  htmls: string[];
  attachments: ParsedAttachment[];
}

function walk(part: Part, out: Collected, depth: number): void {
  const type = parseParameterized(header(part.headers, 'content-type') ?? 'text/plain; charset=us-ascii');
  const disposition = parseParameterized(header(part.headers, 'content-disposition') ?? '');
  // A message nested 20 deep is an attack on the parser, not mail.
  if (type.value.startsWith('multipart/') && type.params.boundary && depth < 20) {
    const children = splitMultipart(part.body, type.params.boundary).map(parsePart);
    if (type.value === 'multipart/alternative') {
      // The richest version a reader can use as text: plain if there is one.
      const plain = children.find((c) => (parseParameterized(header(c.headers, 'content-type') ?? 'text/plain').value === 'text/plain'));
      const chosen = plain ?? children[children.length - 1];
      for (const child of children) {
        if (child === chosen) walk(child, out, depth + 1);
        else {
          // The other alternatives are the same text again — but an
          // alternative may itself carry attachments (multipart/related).
          const sink: Collected = { texts: [], htmls: [], attachments: out.attachments };
          walk(child, sink, depth + 1);
        }
      }
      return;
    }
    for (const child of children) walk(child, out, depth + 1);
    return;
  }

  const filename = disposition.params.filename ?? type.params.name ?? null;
  const isAttachment = disposition.value === 'attachment' || filename !== null || !(type.value === 'text/plain' || type.value === 'text/html');
  const bytes = decodeBody(part);
  if (!isAttachment) {
    const text = decodeCharset(bytes, type.params.charset);
    (type.value === 'text/html' ? out.htmls : out.texts).push(text);
    return;
  }
  const rawId = header(part.headers, 'content-id');
  const contentId = parseMessageIds(rawId)[0] ?? (rawId?.trim() || null);
  const n = out.attachments.length + 1;
  out.attachments.push({
    filename: (filename ?? `attachment-${n}.${EXTENSIONS[type.value] ?? 'bin'}`).replace(/[\\/\r\n\0]/g, '_').slice(0, 255),
    content_type: type.value || 'application/octet-stream',
    inline: disposition.value === 'inline' || (disposition.value === '' && contentId !== null),
    content_id: contentId,
    content: bytes,
  });
}

// ── Machine-sent mail ────────────────────────────────────────────────

/**
 * Why a message was sent by a machine, or null for a person. Answering an
 * out-of-office note or a bounce with "we received your request" starts a
 * loop between two robots; RFC 3834 §2 says what an auto-responder marks.
 */
function automatedReason(headers: Headers, contentType: string, from: MailAddress | null): string | null {
  const auto = header(headers, 'auto-submitted');
  if (auto && auto.toLowerCase() !== 'no') return `Auto-Submitted: ${auto}`;
  const precedence = header(headers, 'precedence')?.toLowerCase();
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return `Precedence: ${precedence}`;
  if (header(headers, 'x-autoreply') || header(headers, 'x-autorespond')) return 'auto-reply header';
  if (header(headers, 'list-id') || header(headers, 'list-unsubscribe')) return 'mailing list';
  if (contentType === 'multipart/report') return 'delivery report';
  if (header(headers, 'return-path')?.replace(/\s/g, '') === '<>') return 'bounce (empty return path)';
  const local = from?.address.split('@')[0];
  if (local === 'mailer-daemon' || local === 'postmaster') return `bounce (${from!.address})`;
  return null;
}

// ── The message ──────────────────────────────────────────────────────

export function parseMessage(raw: Buffer): ParsedMessage {
  const root = parsePart(raw.toString('latin1'));
  const collected: Collected = { texts: [], htmls: [], attachments: [] };
  walk(root, collected, 0);
  const contentType = parseParameterized(header(root.headers, 'content-type') ?? 'text/plain').value;
  const from = parseAddressList(header(root.headers, 'from'))[0] ?? null;
  const text =
    collected.texts.length > 0
      ? collected.texts.map((t) => t.replace(/\r\n/g, '\n').replace(/\s+$/, '')).join('\n\n')
      : htmlToText(collected.htmls.join('\n'));
  return {
    message_id: parseMessageIds(header(root.headers, 'message-id'))[0] ?? null,
    from,
    reply_to: parseAddressList(header(root.headers, 'reply-to'))[0] ?? null,
    to: parseAddressList(header(root.headers, 'to')),
    subject: decodeEncodedWords(header(root.headers, 'subject') ?? '').replace(/\s+/g, ' ').trim(),
    date: parseDate(header(root.headers, 'date')),
    in_reply_to: parseMessageIds(header(root.headers, 'in-reply-to'))[0] ?? null,
    references: parseMessageIds(header(root.headers, 'references')),
    text,
    automated: automatedReason(root.headers, contentType, from),
    attachments: collected.attachments,
  };
}

/** Headers only — for a message too large to fetch whole. */
export function parseHeadersOnly(raw: Buffer): ParsedMessage {
  const parsed = parseMessage(Buffer.concat([raw, Buffer.from('\r\n\r\n')]));
  return { ...parsed, text: '', attachments: [] };
}
