import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { AuditInfo, PlatformHooks } from '../server/platform.js';
import type { CaseDetail, CaseRow, IntakeResult, ReporterView } from '../shared/types.js';

/**
 * MOD-16's four correctness properties, each proven here:
 *
 * 1. **The reporter is not identifiable.** Nothing in the schema can hold an
 *    identity the reporter did not volunteer, and the access code — the only
 *    link between person and case — exists in exactly one response and
 *    nowhere on disk.
 * 2. **Internal notes never reach the reporter.** The two-way channel and the
 *    handler's working notes share a table and are separated by one column,
 *    so the separation is tested at the boundary rather than assumed.
 * 3. **The statutory deadlines are derived from the clock.** § 17 Abs. 1 and
 *    Abs. 2 HinSchG, recomputed on every read, with the directive's fallback
 *    when no acknowledgement was ever sent.
 * 4. **Erasure erases and the trail survives.** § 11 Abs. 5: the content goes,
 *    the proof that a compliant procedure ran stays.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

/** Pinned clock. Every deadline in this module is a question about now. */
const T0 = Date.parse('2026-05-04T08:00:00Z');
const DAY = 86_400_000;

let db: Database.Database;
let app: Express;
let cookie: string;
let nowMs = T0;
let audits: AuditInfo[] = [];

const recordingPlatform: PlatformHooks = {
  async audit(info) {
    audits.push(info);
  },
  async notify() {
    /* unused */
  },
};

async function harness(): Promise<void> {
  db = openDb(':memory:');
  nowMs = T0;
  audits = [];
  // Lookups unthrottled by default; the throttle has its own describe block.
  app = createApp({ db, auth, now: () => nowMs, platform: recordingPlatform, lookupRateLimitRpm: 0 });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(harness);

async function file(patch: Record<string, unknown> = {}): Promise<IntakeResult> {
  const res = await request(app)
    .post('/api/public/reports')
    .send({
      category: 'corruption',
      subject: 'Einkäufer nimmt Geschenke an',
      body: 'Ein Kollege im Einkauf hat Geschenke eines Lieferanten angenommen.',
      ...patch,
    });
  expect(res.status).toBe(201);
  return res.body as IntakeResult;
}

async function caseIdOf(ref: string): Promise<number> {
  const res = await request(app).get('/api/cases').set('Cookie', cookie);
  const found = (res.body.cases as CaseRow[]).find((row) => row.ref === ref);
  expect(found, `no case ${ref}`).toBeDefined();
  return found!.id;
}

async function detail(id: number): Promise<CaseDetail> {
  const res = await request(app).get(`/api/cases/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as CaseDetail;
}

async function lookup(code: string): Promise<ReporterView> {
  const res = await request(app).post('/api/public/case').send({ code });
  expect(res.status).toBe(200);
  return res.body as ReporterView;
}

// ═══════════════════════════════════════════════════════════════════════

describe('filing a report', () => {
  it('needs no login, no name and no email', async () => {
    const result = await file({ contact: undefined });
    expect(result.ref).toMatch(/^WB-2026-\d{4}$/);
    expect(result.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  });

  it('tells the reporter when they are owed an acknowledgement', async () => {
    // § 17 Abs. 1 HinSchG. The reporter has to be able to tell whether the
    // organisation is late without asking the organisation.
    const result = await file();
    expect(result.acknowledge_due_at).toBe('2026-05-11T08:00:00Z');
  });

  it('numbers cases per year, in sequence', async () => {
    expect((await file()).ref).toBe('WB-2026-0001');
    expect((await file()).ref).toBe('WB-2026-0002');
    nowMs = Date.parse('2027-01-02T08:00:00Z');
    expect((await file()).ref).toBe('WB-2027-0001');
  });

  it('refuses a category that is not in the config', async () => {
    const res = await request(app)
      .post('/api/public/reports')
      .send({ category: 'gossip', subject: 'x', body: 'y' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('category');
  });

  it('refuses an empty report rather than filing a blank case', async () => {
    for (const patch of [{ subject: '' }, { body: '   ' }]) {
      const res = await request(app)
        .post('/api/public/reports')
        .send({ category: 'fraud', subject: 'x', body: 'y', ...patch });
      expect(res.status).toBe(422);
    }
  });

  it('publishes the categories and the statutory windows without a session', async () => {
    const res = await request(app).get('/api/public/config');
    expect(res.status).toBe(200);
    expect(res.body.acknowledge_days).toBe(7);
    expect(res.body.feedback_months).toBe(3);
    expect(res.body.categories.length).toBeGreaterThan(5);
  });
});

describe('the reporter is not identifiable', () => {
  it('stores no identity anywhere when none was given', async () => {
    await file({ contact: undefined });
    const row = db.prepare('SELECT * FROM cases').get() as Record<string, unknown>;
    expect(row.contact).toBeNull();
    // Not "we do not show it" — there is nowhere to put it. If a column for
    // an IP, a session or a user agent ever appears, this fails.
    const columns = Object.keys(row);
    expect(columns).toEqual(['id', 'ref', 'category', 'subject', 'body', 'contact', 'code_hash', 'received_at']);
  });

  it('keeps the case marked anonymous for the handler', async () => {
    const { ref } = await file({ contact: undefined });
    const row = await detail(await caseIdOf(ref));
    expect(row.anonymous).toBe(true);
    expect(row.contact).toBeNull();
  });

  it('keeps whatever contact the reporter chose to give, verbatim', async () => {
    const { ref } = await file({ contact: 'Nur über den Zugangscode, bitte' });
    const row = await detail(await caseIdOf(ref));
    expect(row.anonymous).toBe(false);
    expect(row.contact).toBe('Nur über den Zugangscode, bitte');
  });

  it('never writes the access code to disk — only its hash', async () => {
    const { code } = await file();
    const row = db.prepare('SELECT * FROM cases').get() as Record<string, string>;
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(code.replace(/-/g, ''));
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the code exactly once — the handler never sees it', async () => {
    const { ref, code } = await file();
    const row = await detail(await caseIdOf(ref));
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, '').slice(0, 8));
    const list = await request(app).get('/api/cases').set('Cookie', cookie);
    expect(JSON.stringify(list.body)).not.toContain(code.replace(/-/g, '').slice(0, 8));
  });

  it('sends the ref and the verb to the audit log, never the report', async () => {
    // PS-07 is a different service with a different audience. "WB-2026-0001
    // was received" is an audit trail; the allegation is not part of one.
    await file({ body: 'Ein sehr spezifischer belastender Satz.' });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.resource).toBe('case:WB-2026-0001');
    expect(JSON.stringify(audits[0])).not.toContain('belastender');
  });
});

describe('the reporter comes back with their code', () => {
  it('reads their own case without identifying themselves', async () => {
    const { ref, code } = await file();
    const view = await lookup(code);
    expect(view.ref).toBe(ref);
    expect(view.status).toBe('received');
  });

  it('tolerates the code typed back in any case, spacing or grouping', async () => {
    const { code } = await file();
    for (const variant of [code.toLowerCase(), code.replace(/-/g, ''), code.replace(/-/g, ' ')]) {
      expect((await lookup(variant)).status).toBe('received');
    }
  });

  it('answers 404 for a wrong code and for a malformed one alike', async () => {
    await file();
    for (const code of ['AAAA-AAAA-AAAA-AAAA-AAAA', 'not-a-code', '', null]) {
      const res = await request(app).post('/api/public/case').send({ code });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No case matches that access code');
    }
  });

  it('takes the code in the body, never in the URL', async () => {
    // A query string survives in request logs, browser history, `Referer`
    // headers and every proxy in between. This code is the only thing
    // standing between a whistleblower and exposure.
    const { code } = await file();
    const res = await request(app).get(`/api/public/case?code=${encodeURIComponent(code)}`);
    // There is no such route at all — the GET falls through to the session
    // gate and is refused there. What matters is only that no arrangement of
    // a code in a query string ever returns a case.
    expect(res.status).not.toBe(200);
    expect(res.body.ref).toBeUndefined();
  });

  it('adds a follow-up to their own channel', async () => {
    const { ref, code } = await file();
    const res = await request(app).post('/api/public/case/messages').send({ code, body: 'Noch ein Beleg dazu.' });
    expect(res.status).toBe(201);
    expect((res.body as ReporterView).messages).toHaveLength(1);
    const row = await detail(await caseIdOf(ref));
    expect(row.messages[0]!.author_type).toBe('reporter');
    expect(row.messages[0]!.visibility).toBe('reporter');
  });

  it('cannot post into a closed case', async () => {
    const { ref, code } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome: 'unsubstantiated' });
    const res = await request(app).post('/api/public/case/messages').send({ code, body: 'Doch noch etwas.' });
    expect(res.status).toBe(409);
  });

  it('one code opens one case and no other', async () => {
    const first = await file({ subject: 'Erster Fall' });
    const second = await file({ subject: 'Zweiter Fall' });
    expect((await lookup(first.code)).ref).toBe(first.ref);
    expect((await lookup(second.code)).ref).toBe(second.ref);
    expect((await lookup(first.code)).subject).toBe('Erster Fall');
  });
});

describe('internal notes never reach the reporter', () => {
  it('shows the handler both kinds and the reporter only theirs', async () => {
    const { ref, code } = await file();
    const id = await caseIdOf(ref);
    await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'internal', body: 'Verdacht betrifft Herrn K. aus dem Einkauf.' });
    await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'reporter', body: 'Wir prüfen Ihren Hinweis.' });

    const handlerView = await detail(id);
    expect(handlerView.messages).toHaveLength(2);

    const view = await lookup(code);
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]!.body).toBe('Wir prüfen Ihren Hinweis.');
    // The name in the internal note is exactly the thing that must not leak.
    expect(JSON.stringify(view)).not.toContain('Herrn K.');
  });

  it('refuses a message with no visibility rather than guessing one', async () => {
    // Defaulting would be the bug: whichever default is chosen, half the
    // callers that forget the field get the wrong one, and one of those
    // halves publishes an internal note.
    const { ref } = await file();
    const id = await caseIdOf(ref);
    const res = await request(app).post(`/api/cases/${id}/messages`).set('Cookie', cookie).send({ body: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('visibility');
  });

  it('does not let a reporter file an internal note through their own route', async () => {
    const { code } = await file();
    const res = await request(app)
      .post('/api/public/case/messages')
      .send({ code, body: 'x', visibility: 'internal' });
    expect(res.status).toBe(201);
    // The public route hard-codes the visibility; the wire cannot choose it.
    const row = db.prepare("SELECT visibility FROM case_events WHERE type = 'message'").get() as {
      visibility: string;
    };
    expect(row.visibility).toBe('reporter');
  });
});

describe('the case lifecycle', () => {
  it('walks received → acknowledged → investigating → closed', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    expect((await detail(id)).status).toBe('received');
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    expect((await detail(id)).status).toBe('acknowledged');
    await request(app).post(`/api/cases/${id}/investigate`).set('Cookie', cookie);
    expect((await detail(id)).status).toBe('investigating');
    const res = await request(app)
      .post(`/api/cases/${id}/close`)
      .set('Cookie', cookie)
      .send({ outcome: 'substantiated' });
    expect(res.status).toBe(200);
    expect((res.body as CaseDetail).outcome).toBe('substantiated');
  });

  it('refuses to close a case that was never acknowledged', async () => {
    // The acknowledgement is the § 17 Abs. 1 act and it starts the feedback
    // clock. A closed case nobody can reopen would bury the fact that it
    // never happened, so the module refuses rather than warns.
    const { ref } = await file();
    const id = await caseIdOf(ref);
    const res = await request(app)
      .post(`/api/cases/${id}/close`)
      .set('Cookie', cookie)
      .send({ outcome: 'out_of_scope' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('received');
  });

  it('refuses to close without an outcome', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    for (const outcome of [undefined, '', 'because', null]) {
      const res = await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome });
      expect(res.status).toBe(422);
    }
  });

  it('refuses to acknowledge twice, and refuses to reopen a closed case', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    expect((await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie)).status).toBe(409);
    await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome: 'referred' });
    expect((await request(app).post(`/api/cases/${id}/investigate`).set('Cookie', cookie)).status).toBe(409);
  });

  it('keeps every step, in order, in the append-only trail', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'reporter', body: 'Zwischenstand.' });
    await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome: 'unsubstantiated' });

    const row = await detail(id);
    expect(row.events.map((event) => event.type)).toEqual([
      'received',
      'status_change',
      'message',
      'status_change',
    ]);
    expect(row.events.at(-1)!.outcome).toBe('unsubstantiated');
    // Nothing is ever updated, so the first status change still records the
    // status it moved away from.
    expect(row.events[1]!.from_status).toBe('received');
  });

  it('records the handler on every decision', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    const row = await detail(id);
    expect(row.events[1]!.actor).toBe('admin');
    expect(row.events[0]!.actor).toBe('reporter');
  });
});

describe('the statutory deadlines, derived on every read', () => {
  it('starts the feedback clock at the acknowledgement', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    nowMs = T0 + 2 * DAY;
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    const row = await detail(id);
    expect(row.acknowledge.state).toBe('met');
    expect(row.feedback.due_at).toBe('2026-08-06T08:00:00Z');
  });

  it('starts it at the seven-day expiry when nobody ever acknowledged', async () => {
    // Art. 9(1)(f) of the directive. Failing to acknowledge does not
    // postpone the feedback obligation, it starts it — so an untouched case
    // accrues both failures rather than none.
    const { ref } = await file();
    const id = await caseIdOf(ref);
    nowMs = T0 + 200 * DAY;
    const row = await detail(id);
    expect(row.acknowledge.state).toBe('missed');
    expect(row.feedback.due_at).toBe('2026-08-11T08:00:00Z');
    expect(row.feedback.state).toBe('missed');
  });

  it('does not treat an acknowledgement as feedback', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    nowMs = T0 + 120 * DAY;
    expect((await detail(id)).feedback.state).toBe('missed');
  });

  it('does not treat an internal note as feedback', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'internal', body: 'Sehr gründliche Notiz, die niemand sieht.' });
    nowMs = T0 + 120 * DAY;
    expect((await detail(id)).feedback.state).toBe('missed');
  });

  it('does not let the reporter satisfy the obligation on the organisation’s behalf', async () => {
    const { ref, code } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    await request(app).post('/api/public/case/messages').send({ code, body: 'Ich hätte noch etwas.' });
    nowMs = T0 + 120 * DAY;
    expect((await detail(id)).feedback.state).toBe('missed');
  });

  it('counts a message the reporter can read as feedback', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    nowMs = T0 + 30 * DAY;
    await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'reporter', body: 'Wir haben geprüft und Folgendes veranlasst.' });
    nowMs = T0 + 120 * DAY;
    expect((await detail(id)).feedback.state).toBe('met');
  });

  it('counts the closure as feedback too', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    nowMs = T0 + 30 * DAY;
    await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome: 'unsubstantiated' });
    nowMs = T0 + 120 * DAY;
    expect((await detail(id)).feedback.state).toBe('met');
  });

  it('records a late acknowledgement as missed, not as met', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    nowMs = T0 + 10 * DAY;
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    const row = await detail(id);
    expect(row.acknowledge.state).toBe('missed');
    expect(row.acknowledge.met_at).toBe('2026-05-14T08:00:00Z');
  });

  it('shows the reporter the dates they are owed by', async () => {
    const { code } = await file();
    const view = await lookup(code);
    expect(view.acknowledge_due_at).toBe('2026-05-11T08:00:00Z');
    expect(view.feedback_due_at).toBe('2026-08-11T08:00:00Z');
    expect(view.acknowledged_at).toBeNull();
  });
});

describe('the queue and the overview', () => {
  it('filters by status, by category and by what needs attention', async () => {
    const quiet = await file({ category: 'fraud' });
    const late = await file({ category: 'environment' });
    const quietId = await caseIdOf(quiet.ref);
    await request(app).post(`/api/cases/${quietId}/acknowledge`).set('Cookie', cookie);

    nowMs = T0 + 6 * DAY;
    const byStatus = await request(app).get('/api/cases?status=acknowledged').set('Cookie', cookie);
    expect((byStatus.body.cases as CaseRow[]).map((row) => row.ref)).toEqual([quiet.ref]);

    const byCategory = await request(app).get('/api/cases?category=environment').set('Cookie', cookie);
    expect((byCategory.body.cases as CaseRow[]).map((row) => row.ref)).toEqual([late.ref]);

    const attention = await request(app).get('/api/cases?attention=true').set('Cookie', cookie);
    expect((attention.body.cases as CaseRow[]).map((row) => row.ref)).toEqual([late.ref]);
  });

  it('drops a closed case out of the attention list but keeps the miss on record', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    nowMs = T0 + 10 * DAY;
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome: 'unsubstantiated' });
    const attention = await request(app).get('/api/cases?attention=true').set('Cookie', cookie);
    expect(attention.body.cases).toHaveLength(0);
    expect((await detail(id)).acknowledge.state).toBe('missed');
  });

  it('refuses an unknown status or category rather than returning everything', async () => {
    for (const query of ['status=pending', 'category=gossip']) {
      const res = await request(app).get(`/api/cases?${query}`).set('Cookie', cookie);
      expect(res.status).toBe(422);
    }
  });

  it('counts obligations, not cases — one case can be late twice', async () => {
    await file();
    await file();
    nowMs = T0 + 200 * DAY;
    const res = await request(app).get('/api/overview').set('Cookie', cookie);
    expect(res.body).toMatchObject({
      total: 2,
      open: 2,
      awaiting_acknowledgement: 2,
      acknowledgement_missed: 2,
      feedback_missed: 2,
    });
  });
});

describe('§ 11 Abs. 5 — erasure after three years', () => {
  async function concludedCase(): Promise<{ id: number; code: string }> {
    const { ref, code } = await file({ contact: 'anna@example.de' });
    const id = await caseIdOf(ref);
    await request(app).post(`/api/cases/${id}/acknowledge`).set('Cookie', cookie);
    await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'reporter', body: 'Wir haben Ihren Hinweis geprüft.' });
    await request(app).post(`/api/cases/${id}/close`).set('Cookie', cookie).send({ outcome: 'substantiated' });
    return { id, code };
  }

  it('dates the retention from the conclusion, not from receipt', async () => {
    const { id } = await concludedCase();
    expect((await detail(id)).erase_due_on).toBe('2029-05-04');
  });

  it('refuses to erase a case that is still running', async () => {
    const { ref } = await file();
    const id = await caseIdOf(ref);
    const res = await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('still open');
  });

  it('refuses to erase before the three years are up', async () => {
    const { id } = await concludedCase();
    const res = await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('2029-05-04');
  });

  it('erases early only on a deliberate act', async () => {
    const { id } = await concludedCase();
    const res = await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie).send({ force: true });
    expect(res.status).toBe(200);
  });

  it('removes the report, the contact and every message body', async () => {
    const { id } = await concludedCase();
    nowMs = Date.parse('2029-06-01T08:00:00Z');
    await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie);

    const row = await detail(id);
    expect(row.subject).toBeNull();
    expect(row.body).toBeNull();
    expect(row.contact).toBeNull();
    expect(row.messages.every((message) => message.body === null)).toBe(true);

    // …and not just in the response.
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM cases WHERE id = ?').get(id),
      db.prepare('SELECT * FROM case_events WHERE case_id = ?').all(id),
    ]);
    expect(dump).not.toContain('anna@example.de');
    expect(dump).not.toContain('geprüft');
  });

  it('keeps the skeleton and the trail, so the procedure can still be proven', async () => {
    const { id } = await concludedCase();
    nowMs = Date.parse('2029-06-01T08:00:00Z');
    const row = (await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie)).body as CaseDetail;
    expect(row.ref).toBe('WB-2026-0001');
    expect(row.category).toBe('corruption');
    expect(row.status).toBe('closed');
    expect(row.outcome).toBe('substantiated');
    expect(row.acknowledge.state).toBe('met');
    expect(row.events.map((event) => event.type)).toContain('erased');
  });

  it('is irreversible, and blocks further work on the case', async () => {
    const { id, code } = await concludedCase();
    nowMs = Date.parse('2029-06-01T08:00:00Z');
    await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie);

    expect((await request(app).post(`/api/cases/${id}/erase`).set('Cookie', cookie)).status).toBe(409);
    const message = await request(app)
      .post(`/api/cases/${id}/messages`)
      .set('Cookie', cookie)
      .send({ visibility: 'internal', body: 'x' });
    expect(message.status).toBe(409);

    // The reporter's code still resolves — the case existed — but there is
    // nothing left to read.
    const view = await lookup(code);
    expect(view.body).toBeNull();
    expect(view.erased_at).not.toBeNull();
  });

  it('counts cases past their retention date in the overview', async () => {
    await concludedCase();
    nowMs = Date.parse('2029-06-01T08:00:00Z');
    const res = await request(app).get('/api/overview').set('Cookie', cookie);
    expect(res.body.due_for_erasure).toBe(1);
  });
});

describe('who may see what', () => {
  const guarded: [string, string][] = [
    ['get', '/api/config'],
    ['get', '/api/overview'],
    ['get', '/api/cases'],
    ['get', '/api/cases/1'],
    ['post', '/api/cases/1/acknowledge'],
    ['post', '/api/cases/1/investigate'],
    ['post', '/api/cases/1/close'],
    ['post', '/api/cases/1/messages'],
    ['post', '/api/cases/1/erase'],
  ];

  it.each(guarded)('%s %s needs a session', async (method, path) => {
    const res = await (request(app) as never as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(401);
  });

  const open: [string, string][] = [
    ['get', '/api/health'],
    ['get', '/api/ready'],
    ['get', '/api/public/config'],
  ];

  it.each(open)('%s %s is public, by design', async (method, path) => {
    const res = await (request(app) as never as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(200);
  });

  it('answers 404 for a case id that is not a number', async () => {
    const res = await request(app).get('/api/cases/abc').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('answers 404 for a case that does not exist', async () => {
    const res = await request(app).get('/api/cases/999').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('the access-code lookup is throttled', () => {
  it('cuts off a sweep of guesses without blocking the rest of the app', async () => {
    const throttled = createApp({ db, auth, now: () => nowMs, lookupRateLimitRpm: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await request(throttled).post('/api/public/case').send({ code: 'AAAA-AAAA-AAAA-AAAA-AAAA' });
      expect(res.status).toBe(404);
    }
    const blocked = await request(throttled).post('/api/public/case').send({ code: 'AAAA-AAAA-AAAA-AAAA-AAAA' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');

    // Filing a report is a different route and stays open — a flood of
    // guesses must not close the channel for someone trying to report.
    const filed = await request(throttled)
      .post('/api/public/reports')
      .send({ category: 'other', subject: 'x', body: 'y' });
    expect(filed.status).toBe(201);
  });

  it('refills over time rather than locking an address out', async () => {
    let clock = T0;
    const throttled = createApp({ db, auth, now: () => clock, lookupRateLimitRpm: 2 });
    const guess = () => request(throttled).post('/api/public/case').send({ code: 'AAAA-AAAA-AAAA-AAAA-AAAA' });
    await guess();
    await guess();
    expect((await guess()).status).toBe(429);
    clock += 60_000;
    expect((await guess()).status).toBe(404);
  });
});
