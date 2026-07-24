import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type PlatformHooks, type TicketCreatedInfo } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'agent',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
  intakeSecret: 'test-intake-secret',
};

let db: Database.Database;

function appWith(platform: PlatformHooks): Express {
  return createApp({ db, auth, now: () => Date.parse('2026-07-19T09:00:00Z'), platform });
}

async function agentCookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'agent', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('platform integration', () => {
  it('fires ticketCreated on web intake', async () => {
    const calls: TicketCreatedInfo[] = [];
    const app = appWith({
      ...noopPlatform,
      async ticketCreated(info) {
        calls.push(info);
      },
    });
    const res = await request(app)
      .post('/api/intake/web')
      .send({ requester_name: 'Zoe', requester_email: 'zoe@example.com', subject: 'Help', body: 'It broke' });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe(res.body.ref);
    expect(calls[0]!.requesterEmail).toBe('zoe@example.com');
  });

  it('a failing ticketCreated hook never fails intake (best-effort)', async () => {
    const app = appWith({
      ...noopPlatform,
      async ticketCreated() {
        throw new Error('audit log down');
      },
    });
    const res = await request(app)
      .post('/api/intake/web')
      .send({ requester_name: 'Zoe', requester_email: 'zoe@example.com', subject: 'Help', body: 'x' });
    expect(res.status).toBe(201);
  });

  it('suggest-reply returns the AI draft, or 501 when unconfigured', async () => {
    // Configured AI → returns the draft.
    const withAi = appWith({
      ...noopPlatform,
      async suggestReply(info) {
        return `Draft reply for ${info.ref}`;
      },
    });
    const cookie = await agentCookie(withAi);
    const created = await request(withAi)
      .post('/api/intake/web')
      .send({ requester_name: 'Zoe', requester_email: 'zoe@example.com', subject: 'Help', body: 'x' });
    const suggest = await request(withAi).post(`/api/tickets/${created.body.ref}/suggest-reply`).set('Cookie', cookie);
    expect(suggest.status).toBe(200);
    expect(suggest.body.suggestion).toContain(created.body.ref);

    // Standalone (no AI) → 501.
    const standalone = createApp({ db, auth, platform: buildPlatform({}) });
    const c2 = await agentCookie(standalone);
    const s2 = await request(standalone).post(`/api/tickets/${created.body.ref}/suggest-reply`).set('Cookie', c2);
    expect(s2.status).toBe(501);
  });
});
