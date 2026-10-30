import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, lookupToken, type AuthConfig } from '../server/auth.js';
import { DEFAULT_POLICY } from '../server/sla-config.js';
import { noopPlatform, type AttachmentCopy, type PlatformHooks, type RequesterMail } from '../server/platform.js';
import type { PublicTicket, SlaPolicy, TicketDetail } from '../shared/types.js';

/**
 * The helpdesk features a manager configures and agents and requesters use:
 * the versioned SLA policy in business hours, attachments, canned responses,
 * satisfaction ratings, and mail to the requester through PS-03.
 *
 * Clock: Friday 23 October 2026, 16:00 in Vienna (14:00Z), injected.
 */

const auth: AuthConfig = { username: 'agent', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false, intakeSecret: 'intake' };
const as = (access: AccessLevel, actor = 'mia@desk.example') => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const MANAGER = as('manage', 'lead@desk.example');
const AGENT = as('edit');
const VIEWER = as('view');
const FRIDAY = Date.parse('2026-10-23T14:00:00Z');
const MIN = 60_000;

let db: Database.Database;
let app: Express;
let nowMs: number;
let mails: RequesterMail[];
let copies: AttachmentCopy[];

const ps: PlatformHooks = {
  ...noopPlatform,
  notificationConfigured: true,
  async mailRequester(m) {
    mails.push(m);
  },
  async attachmentStored(c) {
    copies.push(c);
  },
};

const b64 = (text: string) => Buffer.from(text).toString('base64');

async function open(extra: Record<string, unknown> = {}): Promise<{ ref: string; token: string }> {
  const res = await request(app)
    .post('/api/intake/web')
    .send({ requester_name: 'Anna Huber', requester_email: 'anna@kunde.example', subject: 'Drucker', body: 'Papierstau', ...extra })
    .expect(201);
  return res.body;
}
const detail = async (ref: string) => (await request(app).get(`/api/tickets/${ref}`).set('Cookie', AGENT).expect(200)).body as TicketDetail;
const status = (ref: string, to: string) => request(app).post(`/api/tickets/${ref}/status`).set('Cookie', AGENT).send({ to });

beforeEach(() => {
  db = openDb(':memory:');
  nowMs = FRIDAY;
  mails = [];
  copies = [];
  app = createApp({ db, auth, now: () => nowMs, platform: ps, publicBaseUrl: 'https://support.example', attachmentLimits: { maxBytes: 1000, perMessage: 2 } });
  db.prepare("INSERT INTO agents (name, email, created_at) VALUES ('Mia', 'mia@desk.example', 'x')").run();
});

const businessPolicy = (over: Partial<SlaPolicy> = {}): SlaPolicy => ({
  ...DEFAULT_POLICY,
  targets: { ...DEFAULT_POLICY.targets, normal: { first_response_minutes: 240, resolution_minutes: 960, business_hours: true } },
  pause_on_pending: true,
  ...over,
});

describe('the SLA policy, set in the UI', () => {
  it('only a manager changes it, every problem is named, and a version is saved only when it changes', async () => {
    await request(app).put('/api/sla-policy').set('Cookie', AGENT).send(businessPolicy()).expect(403);
    const bad = await request(app)
      .put('/api/sla-policy')
      .set('Cookie', MANAGER)
      .send({ ...businessPolicy(), timezone: 'Mars/Base', week: [[{ start: '17:00', end: '08:00' }], [], [], [], [], [], []], holidays: [{ date: '2026-13-01', name: 'x' }] })
      .expect(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['timezone', 'week.0.0', 'holidays.0.date']);
    const saved = (await request(app).put('/api/sla-policy').set('Cookie', MANAGER).send(businessPolicy()).expect(200)).body;
    expect(saved.current).toMatchObject({ id: 1, created_by: 'lead@desk.example', created_at: '2026-10-23T14:00:00Z' });
    await request(app).put('/api/sla-policy').set('Cookie', MANAGER).send(businessPolicy()).expect(200);
    expect((await request(app).get('/api/sla-policy').set('Cookie', VIEWER).expect(200)).body.versions).toHaveLength(1);
    expect((await request(app).get('/api/config').set('Cookie', VIEWER).expect(200)).body.sla.normal).toEqual({ first_response_minutes: 240, resolution_minutes: 960, business_hours: true });
  });

  it('a ticket keeps the version it came in under: changing the policy does not rewrite verdicts', async () => {
    const before = await open(); // under the built-in defaults: 4h around the clock
    nowMs += MIN;
    await request(app).put('/api/sla-policy').set('Cookie', MANAGER).send(businessPolicy()).expect(200);
    nowMs += MIN;
    const after = await open();
    expect((await detail(before.ref)).sla).toMatchObject({ policy_version: null, first_response: { due_at: '2026-10-23T18:00:00Z', business_hours: false } });
    // Friday 16:02 + 4 business hours: 58 min on Friday, then Monday until 11:02.
    expect((await detail(after.ref)).sla).toMatchObject({ policy_version: 1, first_response: { due_at: '2026-10-26T10:02:00Z', business_hours: true } });
  });

  it('waiting on the requester pauses the resolution clock; the dashboard counts it', async () => {
    await request(app).put('/api/sla-policy').set('Cookie', MANAGER).send(businessPolicy()).expect(200);
    nowMs += MIN;
    const { ref } = await open();
    await status(ref, 'pending').expect(200);
    nowMs = Date.parse('2026-10-30T09:00:00Z'); // a week later
    const waiting = await detail(ref);
    expect(waiting.sla.resolution.state).toBe('paused');
    expect(waiting.sla.resolution.remaining_minutes).toBe(960);
    expect((await request(app).get('/api/dashboard').set('Cookie', VIEWER).expect(200)).body.totals.paused).toBe(1);
    await status(ref, 'open').expect(200);
    expect((await detail(ref)).sla.resolution.state).toBe('pending');
  });
});

describe('attachments', () => {
  it('come with the request, a reply and a follow-up; are stored here and copied to PS-06', async () => {
    const { ref, token } = await open({ attachments: [{ filename: '../../etc/fehler.txt', content_type: 'text/plain', content_base64: b64('Fehler 42') }] });
    const reply = await request(app)
      .post(`/api/tickets/${ref}/comment`)
      .set('Cookie', AGENT)
      .send({ body: 'Bitte probieren Sie das.', attachments: [{ filename: 'anleitung.pdf', content_type: 'application/pdf', content_base64: b64('%PDF-1.4') }] })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ref}/comment`)
      .set('Cookie', AGENT)
      .send({ body: 'intern', visibility: 'internal', attachments: [{ filename: 'notiz.html', content_type: 'text/html', content_base64: b64('<script>alert(1)</script>') }] })
      .expect(200);
    const events = (reply.body as TicketDetail).events;
    expect(events[0]!.attachments).toMatchObject([{ filename: 'fehler.txt', content_type: 'text/plain', size: 9 }]);
    expect(events[1]!.attachments[0]!.filename).toBe('anleitung.pdf');
    expect(copies.map((c) => [c.ref, c.filename])).toEqual([
      [ref, 'fehler.txt'],
      [ref, 'anleitung.pdf'],
      [ref, 'notiz.html'],
    ]);

    // The agent downloads anything — always as a download, never rendered.
    const html = (await detail(ref)).events[2]!.attachments[0]!;
    const got = await request(app).get(`/api/tickets/${ref}/attachments/${html.id}`).set('Cookie', VIEWER).expect(200);
    expect(got.headers['content-disposition']).toBe('attachment; filename="notiz.html"; filename*=UTF-8\'\'notiz.html');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toContain('sandbox');

    // The requester sees the public ones; the internal note's file is "not there".
    const page = (await request(app).get(`/api/public/tickets/${ref}?token=${token}`).expect(200)).body as PublicTicket;
    const visible = page.events.flatMap((e) => e.attachments.map((a) => a.filename));
    expect(visible).toEqual(['fehler.txt', 'anleitung.pdf']);
    const pdf = page.events[1]!.attachments[0]!;
    expect((await request(app).get(`/api/public/tickets/${ref}/attachments/${pdf.id}?token=${token}`).expect(200)).body.toString()).toBe('%PDF-1.4');
    await request(app).get(`/api/public/tickets/${ref}/attachments/${html.id}?token=${token}`).expect(404);
    await request(app).get(`/api/public/tickets/${ref}/attachments/${pdf.id}?token=wrong`).expect(404);
    // Another ticket's file through this ticket's link: not found.
    const other = await open();
    await request(app).get(`/api/public/tickets/${other.ref}/attachments/${pdf.id}?token=${other.token}`).expect(404);
  });

  it('too large, too many, not base64: refused before anything is stored', async () => {
    const big = await request(app).post('/api/intake/web').send({ requester_name: 'A', requester_email: 'a@b.example', subject: 's', body: 'b', attachments: [{ filename: 'gross.bin', content_base64: b64('x'.repeat(1001)) }] }).expect(422);
    expect(big.body.details[0].message).toMatch(/at most/);
    await request(app)
      .post('/api/intake/web')
      .send({ requester_name: 'A', requester_email: 'a@b.example', subject: 's', body: 'b', attachments: [1, 2, 3].map((n) => ({ filename: `${n}.txt`, content_base64: b64('x') })) })
      .expect(422);
    await request(app).post('/api/intake/web').send({ requester_name: 'A', requester_email: 'a@b.example', subject: 's', body: 'b', attachments: [{ filename: 'x', content_base64: '***' }] }).expect(422);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
  });
});

describe('canned responses', () => {
  it('a manager keeps them; placeholders are checked when saved and filled per ticket; uses are counted', async () => {
    await request(app).post('/api/canned-responses').set('Cookie', AGENT).send({ title: 'Hallo', body: 'x' }).expect(403);
    const typo = await request(app).post('/api/canned-responses').set('Cookie', MANAGER).send({ title: 'Hallo', body: 'Hallo {{requester_firstname}}' }).expect(422);
    expect(typo.body.details[0].message).toMatch(/unknown placeholder \{\{requester_firstname\}\}/);
    const canned = (await request(app).post('/api/canned-responses').set('Cookie', MANAGER).send({ title: 'Neustart', body: 'Hallo {{requester_first_name}},\n\nbitte starten Sie neu ({{ticket_ref}}).\n\n{{agent_name}}' }).expect(201)).body;
    await request(app).post('/api/canned-responses').set('Cookie', MANAGER).send({ title: 'neustart', body: 'x' }).expect(409);
    const { ref } = await open();
    const filled = (await request(app).post(`/api/tickets/${ref}/canned/${canned.id}/render`).set('Cookie', VIEWER).send({}).expect(200)).body;
    expect(filled.body).toBe(`Hallo Anna,\n\nbitte starten Sie neu (${ref}).\n\nmia@desk.example`);
    await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', AGENT).send({ body: `${filled.body}\nPS`, canned_id: canned.id }).expect(200);
    expect((await request(app).get('/api/canned-responses').set('Cookie', VIEWER).expect(200)).body.canned_responses[0]).toMatchObject({ title: 'Neustart', uses: 1 });
    await request(app).put(`/api/canned-responses/${canned.id}`).set('Cookie', MANAGER).send({ active: false }).expect(200);
    await request(app).post(`/api/tickets/${ref}/canned/${canned.id}/render`).set('Cookie', AGENT).send({}).expect(409);
    await request(app).delete(`/api/canned-responses/${canned.id}`).set('Cookie', MANAGER).expect(200);
    // The reply keeps its full text.
    expect((await detail(ref)).events[1]!.payload).toMatchObject({ body: `${filled.body}\nPS`, canned_id: canned.id });
  });
});

describe('satisfaction ratings', () => {
  it('off by default; on: once per resolution, again after a reopen, and the dashboard derives the figures', async () => {
    const { ref, token } = await open();
    await status(ref, 'resolved').expect(200);
    expect((await request(app).get(`/api/public/tickets/${ref}?token=${token}`).expect(200)).body.rating).toBeNull();
    await request(app).post(`/api/public/tickets/${ref}/rating?token=${token}`).send({ score: 5 }).expect(409);

    await request(app).put('/api/settings').set('Cookie', AGENT).send({ csat: { enabled: true } }).expect(403);
    await request(app).put('/api/settings').set('Cookie', MANAGER).send({ csat: { invite_by_email: true } }).expect(422);
    await request(app).put('/api/settings').set('Cookie', MANAGER).send({ csat: { enabled: true, invite_by_email: true } }).expect(200);

    expect((await request(app).get(`/api/public/tickets/${ref}?token=${token}`).expect(200)).body.rating).toEqual({ can_rate: true, given: null });
    await request(app).post(`/api/public/tickets/${ref}/rating?token=${token}`).send({ score: 6 }).expect(422);
    const rated = (await request(app).post(`/api/public/tickets/${ref}/rating?token=${token}`).send({ score: 2, comment: ' zu langsam ' }).expect(201)).body as PublicTicket;
    expect(rated.rating).toMatchObject({ can_rate: false, given: { score: 2, comment: 'zu langsam' } });
    await request(app).post(`/api/public/tickets/${ref}/rating?token=${token}`).send({ score: 5 }).expect(409);

    // Reopened by a follow-up, resolved again: a new resolution, a new rating — the old one stays.
    await request(app).post(`/api/public/tickets/${ref}/comment?token=${token}`).send({ body: 'geht wieder nicht' }).expect(200);
    await request(app).post(`/api/public/tickets/${ref}/rating?token=${token}`).send({ score: 5 }).expect(409);
    await status(ref, 'resolved').expect(200);
    await request(app).post(`/api/public/tickets/${ref}/rating?token=${token}`).send({ score: 5 }).expect(201);
    expect((await detail(ref)).ratings.map((r) => r.score)).toEqual([2, 5]);
    const second = await open();
    await status(second.ref, 'resolved').expect(200);
    await request(app).post(`/api/public/tickets/${second.ref}/rating?token=${second.token}`).send({ score: 4 }).expect(201);

    const csat = (await request(app).get('/api/dashboard').set('Cookie', VIEWER).expect(200)).body.csat;
    expect(csat).toMatchObject({ count: 3, average: 3.67, csat_percent: 66.7, distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 } });

    // The invitation went out on each resolution after it was switched on, keyed per resolution.
    const invites = mails.filter((m) => m.subject.startsWith('How did we do?'));
    expect(invites.map((m) => m.to)).toEqual(['anna@kunde.example', 'anna@kunde.example']);
    expect(invites[0]!.body).toContain(`https://support.example/ticket/${ref}?token=${lookupToken(auth, ref)}#rating`);
    expect(new Set(invites.map((m) => m.idempotencyKey)).size).toBe(2);
  });
});

describe('mail to the requester', () => {
  it('public replies by email when switched on — internal notes never; the reference rides in the subject', async () => {
    const { ref } = await open();
    await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', AGENT).send({ body: 'vor dem Einschalten' }).expect(200);
    expect(mails).toEqual([]);
    const settings = (await request(app).put('/api/settings').set('Cookie', MANAGER).send({ reply_by_email: true }).expect(200)).body;
    expect(settings).toMatchObject({ settings: { reply_by_email: true }, updated_by: 'lead@desk.example', notification_configured: true, public_base_url: 'https://support.example' });
    await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', AGENT).send({ body: 'intern', visibility: 'internal' }).expect(200);
    await request(app)
      .post(`/api/tickets/${ref}/comment`)
      .set('Cookie', AGENT)
      .send({ body: 'Der Techniker kommt morgen.', attachments: [{ filename: 'termin.ics', content_base64: b64('BEGIN:VCALENDAR') }] })
      .expect(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'anna@kunde.example', subject: `Re: [${ref}] Drucker` });
    expect(mails[0]!.body).toContain('Der Techniker kommt morgen.');
    expect(mails[0]!.body).toContain('Attached on your status page: termin.ics');
    expect(mails[0]!.body).toContain(`https://support.example/ticket/${ref}?token=`);
  });

  it('standalone, nothing is sent and nothing fails', async () => {
    const standalone = createApp({ db, auth, now: () => nowMs });
    await request(standalone).put('/api/settings').set('Cookie', MANAGER).send({ reply_by_email: true, csat: { enabled: true, invite_by_email: true } }).expect(200);
    const { ref } = (await request(standalone).post('/api/intake/web').send({ requester_name: 'A', requester_email: 'a@b.example', subject: 's', body: 'b' }).expect(201)).body;
    await request(standalone).post(`/api/tickets/${ref}/comment`).set('Cookie', AGENT).send({ body: 'hi' }).expect(200);
    await request(standalone).post(`/api/tickets/${ref}/status`).set('Cookie', AGENT).send({ to: 'resolved' }).expect(200);
    expect((await request(standalone).get('/api/settings').set('Cookie', VIEWER).expect(200)).body).toMatchObject({ notification_configured: false, mailbox_configured: false, files_configured: false });
  });
});
