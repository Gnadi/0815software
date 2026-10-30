import type Database from 'better-sqlite3';
import type { MailAttachment, MailMessage } from '@0815software/platform-clients';
import type { MailAction, MailIngest, MailboxStatus } from '../shared/types.js';
import type { AttachmentLimits, NewAttachment } from './attachments.js';
import { safeFilename } from './attachments.js';
import type { PlatformHooks } from './platform.js';
import { readSettings } from './policy.js';
import { addComment, createTicket, DomainError, nowIso, openTicketByRef } from './tickets.js';

/**
 * The mailbox bridge: PS-05 reads the support mailbox over IMAP and hands
 * over the unread mail parsed; this file turns each message into a ticket or
 * a reply, then tells PS-05 which messages it has, so they are marked read.
 * Switched on in the settings (`manage`), and only with INTEGRATION_URL and
 * the platform service token set.
 *
 * - **Once.** Every message is recorded by its Message-ID (`mail_ingests`).
 *   Should the acknowledgement not reach the mailbox, the next poll sees the
 *   message again and recognises it — no second ticket.
 * - **Threading.** A ticket reference in the subject (or the References
 *   header) — "[TKT-2026-0007]", as the acknowledgement and every reply by
 *   email carry it — makes the message a reply on that ticket, if it is not
 *   closed. Otherwise it opens a new ticket.
 * - **Only the requester speaks for the ticket.** A reference is guessable
 *   (it counts up), so a reply from any other address is attached as an
 *   INTERNAL note for an agent to judge: it reaches neither the requester's
 *   page nor reopens the ticket.
 * - **No robot conversations.** Auto-replies, bounces and list mail (PS-05's
 *   `automated`) are recorded and ignored: answering an out-of-office note
 *   with "we received your request" starts a loop.
 * - **A bad message does not block the box.** One that cannot be taken over
 *   is recorded as failed and acknowledged; it stays in the mailbox, read.
 */

const REF = /\bTKT-\d{4}-\d{4,}\b/i;
const BODY_MAX = 8000;
const BATCH = 20;

/** Where a reply's own text ends and the quoted thread begins. */
const QUOTE_MARKERS = [
  /^On .{1,300} wrote:\s*$/m,
  /^Am .{1,300} schrieb .{1,300}:\s*$/m,
  /^-{2,}\s*(?:Original Message|Ursprüngliche Nachricht)\s*-{2,}\s*$/im,
  /^(?:From|Von):\s.+\r?\n(?:Sent|Gesendet|Date|Datum):\s/m,
];

/** The new text of a reply, without the thread it quotes — or all of it, if that would leave nothing. */
export function replyText(text: string): string {
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const own = text
    .slice(0, cut)
    .replace(/(?:^|\n)(?:>.*(?:\n|$))+\s*$/, '')
    .trim();
  return own === '' ? text.trim() : own;
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** The files to take over, and a note on the ones left out. */
function takeAttachments(files: readonly MailAttachment[], limits: AttachmentLimits): { take: NewAttachment[]; notes: string[] } {
  const take: NewAttachment[] = [];
  const notes: string[] = [];
  for (const f of files) {
    // An embedded image is the signature's logo far more often than content.
    if (f.inline && f.content_type.startsWith('image/')) continue;
    if (f.size > limits.maxBytes) notes.push(`${f.filename} (${megabytes(f.size)}, more than ${megabytes(limits.maxBytes)})`);
    else if (take.length >= limits.perMessage) notes.push(`${f.filename} (more than ${limits.perMessage} files)`);
    else take.push({ filename: safeFilename(f.filename), contentType: f.content_type || 'application/octet-stream', bytes: Buffer.from(f.content_base64, 'base64') });
  }
  return { take, notes };
}

function bodyOf(m: MailMessage, text: string, notes: string[], attachments: number): string {
  let body = text;
  if (m.body_omitted) body = `(This message is ${megabytes(m.size)} — too large to take over. It is still in the mailbox.)`;
  else if (body === '') body = attachments > 0 ? '(No text — see the attachments.)' : '(No text.)';
  if (notes.length > 0) body += `\n\n[Not taken over — still in the mailbox: ${notes.join('; ')}]`;
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 20)}\n[…shortened]` : body;
}

export interface MailboxDeps {
  db: Database.Database;
  platform: PlatformHooks;
  now: () => number;
  limits: AttachmentLimits;
  /** Acknowledge a new ticket to its requester, as web intake does. */
  ticketCreated: (info: { ref: string; subject: string; requesterName: string; requesterEmail: string }) => Promise<void>;
}

interface IngestOutcome {
  action: MailAction;
  reason: string | null;
  ticketRef: string | null;
}

/** Turn one message into a ticket, a reply or a note — or record why not. Never throws; null for a message taken over before. */
export async function ingestMessage(deps: MailboxDeps, connectionId: number, uidvalidity: number, m: MailMessage): Promise<MailIngest | null> {
  const { db } = deps;
  const key = m.message_id ? `mid:${m.message_id.toLowerCase()}` : `uid:${connectionId}:${uidvalidity}:${m.uid}`;
  if (db.prepare('SELECT 1 FROM mail_ingests WHERE dedupe_key = ?').get(key)) return null; // taken over before
  const at = nowIso(deps.now());
  const record = (o: IngestOutcome): MailIngest => {
    const info = db
      .prepare(
        'INSERT INTO mail_ingests (dedupe_key, message_id, connection_id, uid, from_address, subject, action, reason, ticket_ref, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(key, m.message_id, connectionId, m.uid, m.from?.address ?? null, m.subject.slice(0, 300), o.action, o.reason, o.ticketRef, at);
    return db.prepare(`${INGEST_SELECT} WHERE id = ?`).get(info.lastInsertRowid) as MailIngest;
  };

  if (m.automated) return record({ action: 'ignored', reason: m.automated, ticketRef: null });
  const sender = m.from?.address;
  if (!sender) return record({ action: 'ignored', reason: 'no sender address', ticketRef: null });

  try {
    const ref = (REF.exec(m.subject) ?? REF.exec([m.in_reply_to ?? '', ...m.references].join(' ')))?.[0]?.toUpperCase() ?? null;
    const existing = ref ? openTicketByRef(db, ref) : null;
    const { take, notes } = m.body_omitted ? { take: [], notes: [] } : takeAttachments(m.attachments, deps.limits);
    if (existing) {
      const body = bodyOf(m, replyText(m.text), notes, take.length);
      // From or Reply-To — a person writing from one address and reading
      // another. Neither is proof (mail proves no sender; SPF and DKIM are
      // the mail server's job): this keeps a guessed reference out, not a
      // forger.
      const requester = existing.requester_email.toLowerCase();
      if (sender === requester || m.reply_to?.address === requester) {
        addComment(db, existing.ref, { body, visibility: 'public', actor: sender, actorType: 'requester', at, attachments: take });
        return record({ action: 'appended', reason: null, ticketRef: existing.ref });
      }
      addComment(db, existing.ref, { body, visibility: 'internal', actor: sender, actorType: 'requester', at, attachments: take, otherSender: sender });
      return record({ action: 'noted', reason: `from ${sender}, not the requester — kept internal`, ticketRef: existing.ref });
    }
    // A new request. Replies should go where the sender asked them to.
    const replyTo = m.reply_to?.address ?? sender;
    const subject = (m.subject.trim() || '(no subject)').slice(0, 200);
    const created = createTicket(db, {
      requesterName: (m.from?.name ?? replyTo).slice(0, 160),
      requesterEmail: replyTo,
      subject,
      body: bodyOf(m, m.text.trim(), notes, take.length),
      priority: 'normal',
      channel: 'email',
      actor: sender,
      actorType: 'requester',
      at,
      attachments: take,
    });
    const outcome = record({ action: 'created', reason: ref ? `${ref} is closed or unknown — opened a new ticket` : null, ticketRef: created });
    // The acknowledgement is best-effort and after the record: a failed mail
    // must not turn a stored ticket into a "failed" message.
    await deps.ticketCreated({ ref: created, subject, requesterName: m.from?.name ?? replyTo, requesterEmail: replyTo });
    return outcome;
  } catch (err) {
    return record({ action: 'failed', reason: err instanceof Error ? err.message : String(err), ticketRef: null });
  }
}

export interface PollResult {
  fetched: number;
  taken: MailIngest[];
  /** Messages already taken over before (the acknowledgement had not arrived). */
  duplicates: number;
  remaining: number;
}

const INGEST_SELECT = 'SELECT id, message_id, from_address, subject, action, reason, ticket_ref, received_at FROM mail_ingests';

export function recentIngests(db: Database.Database, limit = 50): MailIngest[] {
  return db.prepare(`${INGEST_SELECT} ORDER BY id DESC LIMIT ?`).all(limit) as MailIngest[];
}

export interface MailboxPoller {
  poll(): Promise<PollResult>;
  status(): Promise<MailboxStatus>;
  /** The in-process tick; returns the function that stops it. */
  start(tickMs?: number): () => void;
}

export function createMailboxPoller(deps: MailboxDeps): MailboxPoller {
  let lastPoll: MailboxStatus['last_poll'] = null;
  let running = false;

  const poll = async (): Promise<PollResult> => {
    const api = deps.platform.mailbox;
    if (!api) throw new DomainError(501, 'The mailbox needs PS-05 — set INTEGRATION_URL and PLATFORM_SERVICE_TOKEN');
    const { connection_id } = readSettings(deps.db).mailbox;
    if (connection_id === null) throw new DomainError(409, 'Choose the mailbox to read first');
    if (running) throw new DomainError(409, 'The mailbox is being read right now');
    running = true;
    const at = nowIso(deps.now());
    try {
      const batch = await api.fetch(connection_id, BATCH);
      const taken: MailIngest[] = [];
      let duplicates = 0;
      const handled: number[] = [];
      for (const m of batch.messages) {
        const outcome = await ingestMessage(deps, connection_id, batch.uidvalidity, m);
        if (outcome === null) duplicates++;
        else taken.push(outcome);
        handled.push(m.uid);
      }
      // Only now is the mailbox told: should this fail, the messages come back
      // next time and are recognised as taken over.
      if (handled.length > 0) await api.ack(connection_id, batch.uidvalidity, handled);
      lastPoll = { at, ok: true, fetched: batch.messages.length, error: null };
      return { fetched: batch.messages.length, taken, duplicates, remaining: batch.remaining };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastPoll = { at, ok: false, fetched: 0, error: message };
      if (err instanceof DomainError) throw err;
      throw new DomainError(502, `The mailbox could not be read: ${message}`);
    } finally {
      running = false;
    }
  };

  return {
    poll,
    async status() {
      const settings = readSettings(deps.db).mailbox;
      let connections: MailboxStatus['connections'] = [];
      let connectionsError: string | null = null;
      if (deps.platform.mailbox) {
        try {
          connections = await deps.platform.mailbox.connections();
        } catch (err) {
          connectionsError = err instanceof Error ? err.message : String(err);
        }
      }
      return { configured: deps.platform.mailbox !== undefined, settings, connections, connections_error: connectionsError, last_poll: lastPoll, recent: recentIngests(deps.db, 20) };
    },
    start(tickMs = 15_000) {
      if (!deps.platform.mailbox) return () => undefined;
      const timer = setInterval(() => {
        const { enabled, connection_id, poll_seconds } = readSettings(deps.db).mailbox;
        if (!enabled || connection_id === null || running) return;
        if (lastPoll && Date.parse(lastPoll.at) + poll_seconds * 1000 > deps.now()) return;
        poll().catch((err) => console.warn('[mod-12] mailbox poll failed:', err instanceof Error ? err.message : err));
      }, tickMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
