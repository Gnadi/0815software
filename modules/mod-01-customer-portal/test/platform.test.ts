import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type AuditInfo, type PlatformHooks } from '../server/platform.js';
import type { SessionConfig } from '../server/auth.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 1, secureCookie: false };
const ANNA = { email: 'anna.berger@example.de', password: 'demo-anna' };

let documentsDir: string;
let db: ReturnType<typeof openDb>;

function makeApp(platform: PlatformHooks): Express {
  return createApp({ db, session, documentsDir, platform });
}
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send(ANNA);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(async () => {
  documentsDir = mkdtempSync(join(tmpdir(), 'mod01-plat-'));
  db = openDb(':memory:');
  await seed(db, documentsDir);
});
afterEach(() => rmSync(documentsDir, { recursive: true, force: true }));

describe('PS-07 audit integration', () => {
  it('records an audit event on password change', async () => {
    const events: AuditInfo[] = [];
    const app = makeApp({ async audit(info) { events.push(info); } });
    const c = await cookie(app);
    await request(app)
      .post('/api/me/password')
      .set('Cookie', c)
      .send({ currentPassword: 'demo-anna', newPassword: 'a-new-strong-password' })
      .expect(200);
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.action)).toContain('password.changed');
  });

  it('is a no-op when AUDIT_URL is unset (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, session, documentsDir });
    const c = await cookie(app);
    await request(app)
      .post('/api/me/password')
      .set('Cookie', c)
      .send({ currentPassword: 'demo-anna', newPassword: 'another-strong-password' })
      .expect(200);
  });
});
