import type { FieldError, MailFetchResult, MailMessage, MailboxProbeResult } from '../shared/types.js';
import { DomainError } from './errors.js';
import { checkEgressHost, enforceEgress, type EgressPolicy, type ResolveHost } from './egress.js';
import { fetchUnseen, ImapError, markSeen, probeMailbox, type ImapLimits, type MailSecurity, type MailTransport, type MailboxTarget } from './imap.js';
import { parseHeadersOnly, parseMessage } from './mime.js';

/**
 * Mailbox connections — provider `imap`. The credentials (host, port,
 * security, username, password, folder) are stored encrypted like every
 * other connection's and never returned; a module asks for the unread mail
 * and gets it parsed, without ever holding the password.
 *
 * Fetching does not mark anything read. The consumer stores what it got and
 * then acknowledges the UIDs; see server/imap.ts for why.
 */

export const MAILBOX_PROVIDER = 'imap';

/** Validate and normalise the credentials a mailbox connection is created with. */
export function mailboxCredentials(raw: Record<string, unknown>): MailboxTarget {
  const errors: FieldError[] = [];
  const text = (field: string, max: number, required = true): string => {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
      if (required) errors.push({ field: `credentials.${field}`, message: 'is required' });
      return '';
    }
    if (value.length > max) errors.push({ field: `credentials.${field}`, message: `must be at most ${max} characters` });
    return value;
  };
  const host = text('host', 253).trim().toLowerCase();
  if (host && !/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/.test(host)) errors.push({ field: 'credentials.host', message: 'must be a host name or an IP address' });
  const security: MailSecurity = raw.security === undefined || raw.security === 'tls' ? 'tls' : raw.security === 'starttls' ? 'starttls' : (errors.push({ field: 'credentials.security', message: "must be 'tls' or 'starttls' — a mailbox password never travels unencrypted" }), 'tls');
  const portRaw = raw.port ?? (security === 'tls' ? 993 : 143);
  const port = typeof portRaw === 'number' ? portRaw : typeof portRaw === 'string' ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ field: 'credentials.port', message: 'must be a whole number between 1 and 65535' });
  const username = text('username', 320);
  // The password is taken as given: leading or trailing spaces may be part of it.
  const password = typeof raw.password === 'string' && raw.password !== '' ? raw.password : (errors.push({ field: 'credentials.password', message: 'is required' }), '');
  const mailbox = (text('mailbox', 200, false) || 'INBOX').trim();
  // A folder name outside printable ASCII needs IMAP's modified UTF-7; refuse
  // it plainly rather than select the wrong folder.
  if (!/^[\x20-\x7e]+$/.test(mailbox)) errors.push({ field: 'credentials.mailbox', message: 'must be printable ASCII (e.g. INBOX or Support)' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { host, port, security, username, password, mailbox };
}

export function mailboxTarget(credentials: Record<string, unknown>): MailboxTarget {
  // Stored credentials were validated on the way in; re-validating keeps a
  // hand-edited row from reaching the socket in an unexpected shape.
  return mailboxCredentials(credentials);
}

export interface MailboxDeps {
  transport: MailTransport;
  limits: ImapLimits;
  egress: EgressPolicy;
  resolveHost?: ResolveHost;
}

async function approvedAddress(target: MailboxTarget, deps: MailboxDeps): Promise<string> {
  const verdict = await checkEgressHost(target.host, target.port, deps.egress, deps.resolveHost);
  if (!enforceEgress(verdict, deps.egress, 'ps-05', `imap://${target.host}:${target.port}`)) {
    throw new DomainError(403, 'Mailbox host is not allowed', [{ field: 'credentials.host', message: verdict.reason ?? 'internal address' }]);
  }
  return verdict.address ?? target.host;
}

/** Map a session failure onto the HTTP answer: the mailbox, not this service, failed. */
export function mailboxFailure(err: unknown): DomainError {
  if (err instanceof DomainError) return err;
  if (err instanceof ImapError) {
    if (err.kind === 'auth') return new DomainError(502, 'The mailbox refused the login', [{ field: 'credentials', message: err.message }]);
    if (err.kind === 'state') return new DomainError(409, err.message);
    return new DomainError(502, 'The mailbox could not be read', [{ field: 'mailbox', message: err.message }]);
  }
  return new DomainError(502, 'The mailbox could not be read', [{ field: 'mailbox', message: (err as Error)?.message ?? String(err) }]);
}

export async function probe(target: MailboxTarget, deps: MailboxDeps): Promise<MailboxProbeResult> {
  const address = await approvedAddress(target, deps);
  const result = await probeMailbox(target, address, deps.transport, deps.limits);
  return { mailbox: target.mailbox, ...result };
}

export async function fetchMail(target: MailboxTarget, deps: MailboxDeps, limit: number): Promise<MailFetchResult> {
  const address = await approvedAddress(target, deps);
  const fetched = await fetchUnseen(target, address, deps.transport, limit, deps.limits);
  const messages: MailMessage[] = fetched.messages.map((m) => {
    const parsed = m.headersOnly ? parseHeadersOnly(m.raw) : parseMessage(m.raw);
    return {
      uid: m.uid,
      size: m.size,
      body_omitted: m.headersOnly,
      message_id: parsed.message_id,
      from: parsed.from,
      reply_to: parsed.reply_to,
      to: parsed.to,
      subject: parsed.subject,
      date: parsed.date,
      in_reply_to: parsed.in_reply_to,
      references: parsed.references,
      text: parsed.text,
      automated: parsed.automated,
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename,
        content_type: a.content_type,
        size: a.content.length,
        inline: a.inline,
        content_id: a.content_id,
        content_base64: a.content.toString('base64'),
      })),
    };
  });
  return { mailbox: target.mailbox, uidvalidity: fetched.uidvalidity, messages, remaining: fetched.remaining };
}

export async function acknowledge(target: MailboxTarget, deps: MailboxDeps, uidvalidity: number, uids: number[]): Promise<number> {
  const address = await approvedAddress(target, deps);
  return markSeen(target, address, deps.transport, uidvalidity, uids, deps.limits);
}
