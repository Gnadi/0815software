import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel, MailMessage } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { replyText } from '../server/mailbox.js';
import { noopPlatform, type PlatformHooks, type TicketCreatedInfo } from '../server/platform.js';
import type { TicketDetail } from '../shared/types.js';

/**
 * The mailbox bridge (server/mailbox.ts) against a stand-in for PS-05: new
 * mail opens tickets, a reply with the reference lands on its ticket, a reply
 * from anyone else stays internal, robots are ignored, a message seen twice
 * is taken once, and the mailbox is told only after the message is stored.
 */

const auth: AuthConfig = { username: 'agent', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false, intakeSecret: 'intake' };
const as = (access: AccessLevel) => `${COOKIE_NAME}=${createToken(auth, 'lead@desk.example', Date.now(), access)}`;
const MANAGER = as('manage');
const NOW = Date.parse('2026-10-29T09:00:00Z');

let db: Database.Database;
let app: Express;
let inbox: MailMessage[];
let acked: { uidvalidity: number; uids: number[] }[];
let acks: TicketCreatedInfo[];
let fetchFails: boolean;
let ackFails: boolean;

const mail = (uid: number, over: Partial<MailMessage> = {}): MailMessage => ({
  uid,
  size: 500,
  body_omitted: false,
  message_id: `m${uid}@kunde.example`,
  from: { name: 'Anna Huber', address: 'anna@kunde.example' },
  reply_to: null,
  to: [{ name: null, address: 'support@firma.example' }],
  subject: 'Drucker druckt nicht',
  date: '2026-10-29T08:00:00Z',
  in_reply_to: null,
  references: [],
  text: 'Seit heute früh.',
  automated: null,
  attachments: [],
  ...over,
});

const ps05: PlatformHooks = {
  ...noopPlatform,
  async ticketCreated(info) {
    acks.push(info);
  },
  mailbox: {
    async connections() {
      return [{ id: 7, name: 'Support inbox', account: 'support@firma.example @ mail.firma.example', status: 'connected' }];
    },
    async probe() {
      return { mailbox: 'INBOX', uidvalidity: 99, exists: inbox.length, unseen: inbox.length };
    },
    async fetch(_id, limit) {
      if (fetchFails) throw new Error('The mailbox refused the login');
      return { mailbox: 'INBOX', uidvalidity: 99, messages: inbox.slice(0, limit), remaining: Math.max(0, inbox.length - limit) };
    },
    async ack(_id, uidvalidity, uids) {
      if (ackFails) throw new Error('PS-05 is down');
      acked.push({ uidvalidity, uids });
      inbox = inbox.filter((m) => !uids.includes(m.uid));
      return uids.length;
    },
  },
};

const poll = () => request(app).post('/api/mailbox/poll').set('Cookie', MANAGER).send({});
const ticket = async (ref: string) => (await request(app).get(`/api/tickets/${ref}`).set('Cookie', MANAGER).expect(200)).body as TicketDetail;

beforeEach(async () => {
  db = openDb(':memory:');
  inbox = [];
  acked = [];
  acks = [];
  fetchFails = false;
  ackFails = false;
  app = createApp({ db, auth, now: () => NOW, platform: ps05, attachmentLimits: { maxBytes: 100, perMessage: 2 } });
  await request(app).put('/api/settings').set('Cookie', MANAGER).send({ mailbox: { enabled: true, connection_id: 7 } }).expect(200);
});

describe('turning mail into tickets', () => {
  it('a new message opens a ticket, acknowledged to the sender; the mailbox is told afterwards', async () => {
    inbox = [
      mail(1, {
        reply_to: { name: null, address: 'anna.privat@kunde.example' },
        attachments: [
          { filename: 'foto.jpg', content_type: 'image/jpeg', size: 4, inline: false, content_id: null, content_base64: Buffer.from('jpeg').toString('base64') },
          { filename: 'logo.png', content_type: 'image/png', size: 3, inline: true, content_id: 'logo', content_base64: Buffer.from('png').toString('base64') },
          { filename: 'riesig.zip', content_type: 'application/zip', size: 5000, inline: false, content_id: null, content_base64: '' },
        ],
      }),
    ];
    const result = (await poll().expect(200)).body;
    expect(result).toMatchObject({ fetched: 1, duplicates: 0, remaining: 0 });
    expect(result.taken).toMatchObject([{ action: 'created', from_address: 'anna@kunde.example', subject: 'Drucker druckt nicht' }]);
    const ref = result.taken[0].ticket_ref as string;
    const t = await ticket(ref);
    // Replies go where the sender asked; the signature logo is not taken over, the zip is too large.
    expect(t).toMatchObject({ requester_name: 'Anna Huber', requester_email: 'anna.privat@kunde.example', channel: 'email' });
    expect(t.body).toBe('Seit heute früh.\n\n[Not taken over — still in the mailbox: riesig.zip (0 MB, more than 0 MB)]');
    expect(t.events[0]!.attachments.map((a) => a.filename)).toEqual(['foto.jpg']);
    expect(acks).toMatchObject([{ ref, requesterEmail: 'anna.privat@kunde.example' }]);
    expect(acked).toEqual([{ uidvalidity: 99, uids: [1] }]);
  });

  it('a reply with the reference in the subject lands on its ticket, without the quoted thread, and reopens it', async () => {
    inbox = [mail(1)];
    const ref = (await poll().expect(200)).body.taken[0].ticket_ref as string;
    await request(app).post(`/api/tickets/${ref}/status`).set('Cookie', MANAGER).send({ to: 'resolved' }).expect(200);
    inbox = [mail(2, { subject: `AW: [${ref}] Drucker druckt nicht`, text: `Leider wieder kaputt.\n\nAm 29.10.2026 um 10:00 schrieb Support <support@firma.example>:\n> Bitte neu starten.` })];
    expect((await poll().expect(200)).body.taken).toMatchObject([{ action: 'appended', ticket_ref: ref }]);
    const t = await ticket(ref);
    expect(t.status).toBe('open');
    expect(t.events.find((e) => e.type === 'comment')).toMatchObject({ actor: 'anna@kunde.example', actor_type: 'requester', visibility: 'public', payload: { body: 'Leider wieder kaputt.' } });
  });

  it('the requester replying from the From address of a ticket that runs on their Reply-To is still the requester', async () => {
    inbox = [mail(1, { reply_to: { name: null, address: 'anna.privat@kunde.example' } })];
    const ref = (await poll().expect(200)).body.taken[0].ticket_ref as string;
    inbox = [mail(2, { subject: `Re: [${ref}]`, text: 'Noch eine Frage.', reply_to: { name: null, address: 'anna.privat@kunde.example' } })];
    expect((await poll().expect(200)).body.taken).toMatchObject([{ action: 'appended', ticket_ref: ref }]);
  });

  it('a reply from anyone but the requester stays an internal note — a reference is guessable', async () => {
    inbox = [mail(1)];
    const ref = (await poll().expect(200)).body.taken[0].ticket_ref as string;
    await request(app).post(`/api/tickets/${ref}/status`).set('Cookie', MANAGER).send({ to: 'resolved' }).expect(200);
    inbox = [mail(2, { from: { name: 'Mallory', address: 'mallory@evil.example' }, subject: `Re: [${ref}]`, text: 'Bitte an mich überweisen.' })];
    expect((await poll().expect(200)).body.taken).toMatchObject([{ action: 'noted', ticket_ref: ref, reason: 'from mallory@evil.example, not the requester — kept internal' }]);
    const t = await ticket(ref);
    expect(t.status).toBe('resolved');
    expect(t.events.at(-1)).toMatchObject({ visibility: 'internal', payload: { other_sender: 'mallory@evil.example' } });
  });

  it('a reply to a closed ticket opens a new one; robots are ignored', async () => {
    inbox = [mail(1)];
    const ref = (await poll().expect(200)).body.taken[0].ticket_ref as string;
    await request(app).post(`/api/tickets/${ref}/status`).set('Cookie', MANAGER).send({ to: 'resolved' }).expect(200);
    await request(app).post(`/api/tickets/${ref}/status`).set('Cookie', MANAGER).send({ to: 'closed' }).expect(200);
    inbox = [mail(2, { subject: `Re: [${ref}] noch was` }), mail(3, { from: { name: null, address: 'mailer-daemon@mx.example' }, automated: 'bounce (mailer-daemon@mx.example)', subject: `Undelivered: [${ref}]` })];
    const taken = (await poll().expect(200)).body.taken;
    expect(taken).toMatchObject([
      { action: 'created', reason: `${ref} is closed or unknown — opened a new ticket` },
      { action: 'ignored', reason: 'bounce (mailer-daemon@mx.example)', ticket_ref: null },
    ]);
    expect(acked.at(-1)).toEqual({ uidvalidity: 99, uids: [2, 3] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 2 });
  });
});

describe('once, and never stuck', () => {
  it('a message seen again — the acknowledgement had not reached the mailbox — is taken once', async () => {
    inbox = [mail(1)];
    ackFails = true;
    await poll().expect(502);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 });
    ackFails = false;
    const again = (await poll().expect(200)).body;
    expect(again).toMatchObject({ fetched: 1, duplicates: 1, taken: [] });
    expect(acked).toEqual([{ uidvalidity: 99, uids: [1] }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 });
  });

  it('a message that cannot be taken over is recorded as failed and acknowledged, so it does not block the box', async () => {
    inbox = [mail(1, { subject: 'x'.repeat(10), from: { name: 'A'.repeat(500), address: 'a@b.example' } }), mail(2)];
    // Force a failure on the first: a ticket-number counter that cannot advance.
    db.exec("CREATE TRIGGER no_more BEFORE INSERT ON tickets WHEN NEW.subject = 'xxxxxxxxxx' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const taken = (await poll().expect(200)).body.taken;
    expect(taken.map((t: { action: string }) => t.action)).toEqual(['failed', 'created']);
    expect(taken[0].reason).toBe('disk full');
    expect(acked).toEqual([{ uidvalidity: 99, uids: [1, 2] }]);
  });

  it('a large message is a ticket that says so', async () => {
    inbox = [mail(1, { body_omitted: true, size: 30 * 1024 * 1024, text: '' })];
    const ref = (await poll().expect(200)).body.taken[0].ticket_ref as string;
    expect((await ticket(ref)).body).toBe('(This message is 30 MB — too large to take over. It is still in the mailbox.)');
  });
});

describe('the settings and the status page', () => {
  it('manager only; the connections come from PS-05; a failed poll is reported, not hidden', async () => {
    await request(app).get('/api/mailbox').set('Cookie', as('edit')).expect(403);
    await request(app).post('/api/mailbox/poll').set('Cookie', as('edit')).send({}).expect(403);
    fetchFails = true;
    expect((await poll().expect(502)).body.error).toMatch(/refused the login/);
    const status = (await request(app).get('/api/mailbox').set('Cookie', MANAGER).expect(200)).body;
    expect(status).toMatchObject({ configured: true, settings: { enabled: true, connection_id: 7, poll_seconds: 120 }, connections: [{ id: 7, name: 'Support inbox' }], last_poll: { ok: false } });
    expect((await request(app).post('/api/mailbox/test').set('Cookie', MANAGER).send({}).expect(200)).body).toMatchObject({ mailbox: 'INBOX', uidvalidity: 99 });
    await request(app).put('/api/settings').set('Cookie', MANAGER).send({ mailbox: { connection_id: null } }).expect(422);
    await request(app).put('/api/settings').set('Cookie', MANAGER).send({ mailbox: { poll_seconds: 5 } }).expect(422);
  });

  it('standalone there is no mailbox to read, and it says why', async () => {
    const standalone = createApp({ db: openDb(':memory:'), auth, now: () => NOW });
    expect((await request(standalone).get('/api/mailbox').set('Cookie', MANAGER).expect(200)).body).toMatchObject({ configured: false, connections: [] });
    await request(standalone).put('/api/settings').set('Cookie', MANAGER).send({ mailbox: { enabled: true, connection_id: 3 } }).expect(200);
    expect((await request(standalone).post('/api/mailbox/poll').set('Cookie', MANAGER).send({}).expect(501)).body.error).toMatch(/INTEGRATION_URL/);
  });
});

describe('the reply\'s own text', () => {
  it.each([
    ['Danke!\n\nOn Thu, 29 Oct 2026 at 10:00, Support <s@x> wrote:\n> alt', 'Danke!'],
    ['Passt.\n\n-----Ursprüngliche Nachricht-----\nVon: Support', 'Passt.'],
    ['Ok\n\nFrom: Support <s@x>\nSent: Thursday\nSubject: x', 'Ok'],
    ['> nur zitiert\n> sonst nichts', '> nur zitiert\n> sonst nichts'],
  ])('%j', (text, own) => {
    expect(replyText(text)).toBe(own);
  });
});
