import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import type { MatterSummary } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { SessionConfig } from '../server/auth.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type DocumentUploadInfo, type PlatformHooks } from '../server/platform.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 1, secureCookie: false };

let db: Database;
let storageDir: string;

function makeApp(platform: PlatformHooks): Express {
  return createApp({ db, session, storageDir, maxUploadBytes: 1024 * 1024, platform });
}
async function editorCookieAndMatter(app: Express): Promise<{ cookie: string; matterId: number }> {
  const login = await request(app).post('/api/login').send({ username: 'theo', password: 'demo-theo' });
  const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  const matters = (await request(app).get('/api/matters').set('Cookie', cookie)).body.matters as MatterSummary[];
  const matter = matters.find((m) => m.key === 'MAT-2026-014')!; // theo is editor here
  return { cookie, matterId: matter.id };
}

beforeEach(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'mod09-plat-'));
  db = openDb(':memory:');
  await seed(db, storageDir);
});
afterEach(() => rmSync(storageDir, { recursive: true, force: true }));

describe('platform integration on document upload', () => {
  it('mirrors the uploaded bytes and audits the upload', async () => {
    const calls: DocumentUploadInfo[] = [];
    const app = makeApp({ async documentUploaded(info) { calls.push(info); } });
    const { cookie, matterId } = await editorCookieAndMatter(app);
    const bytes = Buffer.from('hello document');
    await request(app)
      .post(`/api/matters/${matterId}/documents?title=Note&filename=note.txt`)
      .set('Cookie', cookie)
      .set('Content-Type', 'text/plain')
      .send(bytes)
      .expect(201);
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.version).toBe(1);
    expect(calls[0]!.bytes.equals(bytes)).toBe(true);
    expect(calls[0]!.contentType).toContain('text/plain');
  });

  it('is a no-op when unconfigured (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, session, storageDir, maxUploadBytes: 1024 * 1024 });
    const { cookie, matterId } = await editorCookieAndMatter(app);
    await request(app)
      .post(`/api/matters/${matterId}/documents?title=N&filename=n.txt`)
      .set('Cookie', cookie)
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('x'))
      .expect(201);
  });
});

describe('cross-document search via PS-09', () => {
  it('proxies to Search when configured, 501 otherwise', async () => {
    const configured = createApp({
      db, session, storageDir, maxUploadBytes: 1024 * 1024,
      platform: {
        async documentUploaded() { /* noop */ },
        async searchDocuments(q: string) {
          return { total: 1, hits: [{ collection: 'documents', id: '1', title: `hit for ${q}`, score: 1, snippet: '', facets: {} }], facets: [] };
        },
      },
    });
    const { cookie } = await editorCookieAndMatter(configured);
    const res = await request(configured).get('/api/search?q=contract').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.hits[0].title).toContain('contract');

    const standalone = createApp({ db, session, storageDir, maxUploadBytes: 1024 * 1024 });
    const { cookie: c2 } = await editorCookieAndMatter(standalone);
    expect((await request(standalone).get('/api/search?q=x').set('Cookie', c2)).status).toBe(501);
  });
});
