import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';

const auth = { username: 'admin', password: 'p', secret: 's', ttlHours: 1, secureCookie: false, serviceToken: 'stack' };
let app: Express;
let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, resendApiKey: null, now: () => Date.parse('2026-11-09T02:00:00Z') });
});

const events = () => db.prepare('SELECT recipient, category, urgency, oncall, title FROM notify_events ORDER BY id').all();

describe('the stack telling its administrators about itself', () => {
  it('reaches nobody until the administrator names recipients', async () => {
    const res = await request(app).post('/api/ops/events').set('X-Service-Token', 'stack').send({ kind: 'backup-failed', title: 'Nightly backup failed', key: 'b1' });
    expect(res.body).toEqual({ recorded: 0, skipped: 0 });
  });

  it('a failed backup goes to the ops recipients, now and through quiet hours', async () => {
    const set = await request(app).put('/api/notify/settings').set('X-Service-Token', 'stack').send({ ops_recipients: ['Ops@Acme.test', 'cto@acme.test'] });
    expect(set.body.ops_recipients).toEqual(['ops@acme.test', 'cto@acme.test']);
    await request(app).post('/api/ops/events').set('X-Service-Token', 'stack').send({ kind: 'backup-failed', title: 'Nightly backup failed', detail: 'ps07 mod04', key: 'b1' }).expect(201);
    expect(events()).toEqual([
      { recipient: 'ops@acme.test', category: 'operations', urgency: 'now', oncall: 1, title: 'Nightly backup failed' },
      { recipient: 'cto@acme.test', category: 'operations', urgency: 'now', oncall: 1, title: 'Nightly backup failed' },
    ]);
  });

  it('takes Alertmanager’s webhook with the stack token as Bearer: firing now, resolved in the digest', async () => {
    await request(app).put('/api/notify/settings').set('X-Service-Token', 'stack').send({ ops_recipients: ['ops@acme.test'] });
    const payload = (status: string) => ({
      version: '4',
      status,
      alerts: [{ status, labels: { alertname: 'ModuleDown', instance: 'invoicing:3004' }, annotations: { summary: 'A module stopped answering' }, startsAt: '2026-11-09T01:55:00Z', fingerprint: 'abc' }],
    });
    expect((await request(app).post('/api/alerts/alertmanager').send(payload('firing'))).status).toBe(401);
    await request(app).post('/api/alerts/alertmanager').set('Authorization', 'Bearer stack').send(payload('firing')).expect(200);
    // Alertmanager repeats itself; one notification per alert and state.
    await request(app).post('/api/alerts/alertmanager').set('Authorization', 'Bearer stack').send(payload('firing')).expect(200);
    await request(app).post('/api/alerts/alertmanager').set('Authorization', 'Bearer stack').send(payload('resolved')).expect(200);
    expect(events()).toEqual([
      { recipient: 'ops@acme.test', category: 'operations', urgency: 'now', oncall: 1, title: 'Stack alert: A module stopped answering' },
      { recipient: 'ops@acme.test', category: 'operations', urgency: 'digest', oncall: 0, title: 'Resolved: A module stopped answering' },
    ]);
  });

  it('refuses ops recipients that are not addresses', async () => {
    expect((await request(app).put('/api/notify/settings').set('X-Service-Token', 'stack').send({ ops_recipients: ['nope'] })).status).toBe(422);
  });
});
