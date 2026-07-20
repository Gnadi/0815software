import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import type {
  DocumentDetail,
  DocumentSummary,
  MatterMember,
  MatterSummary,
} from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { SessionConfig } from '../server/auth.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 1, secureCookie: false };
const MAX_UPLOAD = 1024 * 1024; // 1 MiB for the size-limit test

// Dev credentials from the seed.
const ADMIN = { username: 'admin', password: 'demo-admin' };
const MARA = { username: 'mara', password: 'demo-mara' }; // owner 014, viewer 033
const THEO = { username: 'theo', password: 'demo-theo' }; // editor 014, owner 021, viewer 033
const IRIS = { username: 'iris', password: 'demo-iris' }; // viewer 021, owner 033

let app: Express;
let db: Database;
let storageDir: string;

async function login(creds: { username: string; password: string }): Promise<string> {
  const res = await request(app).post('/api/login').send(creds);
  expect(res.status, `login ${creds.username}`).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function matters(cookie: string): Promise<MatterSummary[]> {
  const res = await request(app).get('/api/matters').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.matters as MatterSummary[];
}

async function matterByKey(cookie: string, key: string): Promise<MatterSummary> {
  const found = (await matters(cookie)).find((m) => m.key === key);
  if (!found) throw new Error(`matter ${key} not visible`);
  return found;
}

async function docsIn(cookie: string, matterId: number): Promise<DocumentSummary[]> {
  const res = await request(app).get(`/api/documents?matter=${matterId}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.documents as DocumentSummary[];
}

function upload(
  cookie: string,
  path: string,
  bytes: Buffer,
  title: string,
  filename: string,
) {
  return request(app)
    .post(`${path}?title=${encodeURIComponent(title)}&filename=${encodeURIComponent(filename)}`)
    .set('Cookie', cookie)
    .set('Content-Type', 'text/plain')
    .send(bytes);
}

beforeAll(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'mod09-test-'));
  db = openDb(':memory:');
  seed(db, storageDir);
  app = createApp({ db, session, storageDir, maxUploadBytes: MAX_UPLOAD });
});

afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of [
      '/api/matters',
      '/api/matters/1',
      '/api/documents',
      '/api/documents/1',
      '/api/documents/1/download',
      '/api/me',
      '/api/users',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('rejects wrong password and unknown username', async () => {
    expect((await request(app).post('/api/login').send({ username: 'mara', password: 'nope' })).status).toBe(401);
    expect((await request(app).post('/api/login').send({ username: 'ghost', password: 'demo-mara' })).status).toBe(401);
  });

  it('logs in and sets an HttpOnly session cookie', async () => {
    const res = await request(app).post('/api/login').send(MARA);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('mara');
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(res.headers['set-cookie']![0]).toContain('mod09_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });

  it('rejects a tampered session token', async () => {
    const cookie = await login(MARA);
    const tampered = cookie.replace(/mod09_session=\d+/, 'mod09_session=999');
    expect((await request(app).get('/api/matters').set('Cookie', tampered)).status).toBe(401);
  });
});

describe('matter visibility', () => {
  it('shows each member only their matters; admin sees all', async () => {
    expect((await matters(await login(MARA))).map((m) => m.key).sort()).toEqual(['MAT-2026-014', 'MAT-2026-033']);
    expect((await matters(await login(THEO))).map((m) => m.key).sort()).toEqual([
      'MAT-2026-014',
      'MAT-2026-021',
      'MAT-2026-033',
    ]);
    expect((await matters(await login(IRIS))).map((m) => m.key).sort()).toEqual(['MAT-2026-021', 'MAT-2026-033']);
    expect((await matters(await login(ADMIN))).map((m) => m.key).sort()).toEqual([
      'MAT-2026-014',
      'MAT-2026-021',
      'MAT-2026-033',
    ]);
  });

  it('reports the correct effective role, admin implicitly owner', async () => {
    expect((await matterByKey(await login(MARA), 'MAT-2026-014')).role).toBe('owner');
    expect((await matterByKey(await login(THEO), 'MAT-2026-014')).role).toBe('editor');
    expect((await matterByKey(await login(IRIS), 'MAT-2026-033')).role).toBe('owner');
    expect((await matterByKey(await login(ADMIN), 'MAT-2026-021')).role).toBe('owner');
  });
});

describe('cross-matter isolation (404, not 403)', () => {
  it('hides a matter a user has no membership on', async () => {
    const iris = await login(IRIS);
    // MAT-2026-014 exists but iris is not a member → 404, never 403.
    const target = await matterByKey(await login(ADMIN), 'MAT-2026-014');
    expect((await request(app).get(`/api/matters/${target.id}`).set('Cookie', iris)).status).toBe(404);
    expect((await request(app).get(`/api/matters/${target.id}/members`).set('Cookie', iris)).status).toBe(404);
  });

  it('hides documents, versions, downloads and tags from a non-member (404)', async () => {
    const admin = await login(ADMIN);
    const mara = await login(MARA); // no access to MAT-2026-021
    const litigation = await matterByKey(admin, 'MAT-2026-021');
    const docs = await docsIn(admin, litigation.id);
    expect(docs.length).toBeGreaterThan(0);

    for (const doc of docs) {
      expect((await request(app).get(`/api/documents/${doc.id}`).set('Cookie', mara)).status).toBe(404);
      expect((await request(app).get(`/api/documents/${doc.id}/download`).set('Cookie', mara)).status).toBe(404);
      expect(
        (await request(app).get(`/api/documents/${doc.id}/versions/1/download`).set('Cookie', mara)).status,
      ).toBe(404);
      // Adding a version / a tag to an invisible document is 404, not 403.
      expect((await upload(mara, `/api/documents/${doc.id}/versions`, Buffer.from('x'), 't', 'f.txt')).status).toBe(404);
      expect(
        (await request(app).post(`/api/documents/${doc.id}/tags`).set('Cookie', mara).send({ tag: 'sneaky' })).status,
      ).toBe(404);
    }

    // A matter-filtered document list for an inaccessible matter is empty.
    expect((await docsIn(mara, litigation.id)).length).toBe(0);
  });
});

describe('role escalation blocked (403)', () => {
  it('a viewer cannot upload a new document', async () => {
    const iris = await login(IRIS); // viewer on MAT-2026-021
    const litigation = await matterByKey(await login(ADMIN), 'MAT-2026-021');
    const res = await upload(iris, `/api/matters/${litigation.id}/documents`, Buffer.from('hi'), 'Nope', 'nope.txt');
    expect(res.status).toBe(403);
  });

  it('a viewer cannot add a version to an existing document', async () => {
    const iris = await login(IRIS);
    const admin = await login(ADMIN);
    const litigation = await matterByKey(admin, 'MAT-2026-021');
    const doc = (await docsIn(admin, litigation.id))[0]!;
    const res = await upload(iris, `/api/documents/${doc.id}/versions`, Buffer.from('hi'), 't', 'f.txt');
    expect(res.status).toBe(403);
  });

  it('an editor cannot manage members (owner only)', async () => {
    const theo = await login(THEO); // editor on MAT-2026-014
    const cust = await matterByKey(await login(ADMIN), 'MAT-2026-014');
    const res = await request(app)
      .post(`/api/matters/${cust.id}/members`)
      .set('Cookie', theo)
      .send({ user_id: 1, role: 'viewer' });
    expect(res.status).toBe(403);
  });

  it('an editor cannot soft-delete a document (owner only)', async () => {
    const theo = await login(THEO); // editor on MAT-2026-014
    const admin = await login(ADMIN);
    const cust = await matterByKey(admin, 'MAT-2026-014');
    const doc = (await docsIn(admin, cust.id))[0]!;
    expect((await request(app).delete(`/api/documents/${doc.id}`).set('Cookie', theo)).status).toBe(403);
  });
});

describe('append-only versioning', () => {
  it('version numbers are gapless per document and derive the current version', async () => {
    const admin = await login(ADMIN);
    const litigation = await matterByKey(admin, 'MAT-2026-021');
    const discovery = (await docsIn(admin, litigation.id)).find((d) => d.title === 'Discovery Index')!;
    const res = await request(app).get(`/api/documents/${discovery.id}`).set('Cookie', admin);
    const detail = res.body as DocumentDetail;
    expect(detail.versions.map((v) => v.version_no)).toEqual([1, 2, 3]);
    expect(detail.document.current_version).toBe(3);
  });

  it('uploading a new version appends without mutating prior versions', async () => {
    const theo = await login(THEO); // editor on MAT-2026-014
    const admin = await login(ADMIN);
    const cust = await matterByKey(admin, 'MAT-2026-014');
    const doc = (await docsIn(admin, cust.id)).find((d) => d.title === 'Board Consent')!; // starts at v1

    const before = (await request(app).get(`/api/documents/${doc.id}`).set('Cookie', admin)).body as DocumentDetail;
    expect(before.document.current_version).toBe(1);
    const v1Sha = before.versions[0]!.sha256;

    const body = Buffer.from('brand new revision bytes');
    const up = await upload(theo, `/api/documents/${doc.id}/versions`, body, 'Board Consent', 'consent-v2.txt');
    expect(up.status).toBe(201);
    const after = up.body as DocumentDetail;

    expect(after.versions.map((v) => v.version_no)).toEqual([1, 2]);
    expect(after.document.current_version).toBe(2);
    // Prior version untouched.
    expect(after.versions[0]!.sha256).toBe(v1Sha);
    // New version records a correct sha-256 of the uploaded bytes.
    expect(after.versions[1]!.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(after.versions[1]!.size_bytes).toBe(body.length);
  });

  it('downloads default to current and serve a specific old version', async () => {
    const theo = await login(THEO);
    const admin = await login(ADMIN);
    const cust = await matterByKey(admin, 'MAT-2026-014');
    const doc = (await docsIn(admin, cust.id)).find((d) => d.title === 'Series B Term Sheet')!;

    const current = await request(app).get(`/api/documents/${doc.id}/download`).set('Cookie', theo);
    expect(current.status).toBe(200);
    expect(current.headers['x-version-no']).toBe(String(doc.current_version));

    const v1 = await request(app).get(`/api/documents/${doc.id}/versions/1/download`).set('Cookie', theo);
    expect(v1.status).toBe(200);
    expect(v1.headers['x-version-no']).toBe('1');
    // The recorded sha-256 matches the bytes actually served.
    const served = Buffer.isBuffer(v1.body) && v1.body.length ? v1.body : Buffer.from(v1.text ?? '', 'utf8');
    expect(v1.headers['x-content-sha256']).toBe(createHash('sha256').update(served).digest('hex'));

    // A non-existent version number 404s.
    expect((await request(app).get(`/api/documents/${doc.id}/versions/99/download`).set('Cookie', theo)).status).toBe(404);
  });
});

describe('upload size limit', () => {
  it('rejects an over-limit upload with 413', async () => {
    const mara = await login(MARA); // owner on MAT-2026-014
    const cust = await matterByKey(mara, 'MAT-2026-014');
    const big = Buffer.alloc(MAX_UPLOAD + 1024, 0x61);
    const res = await upload(mara, `/api/matters/${cust.id}/documents`, big, 'Too big', 'big.txt');
    expect(res.status).toBe(413);
  });

  it('rejects an empty upload body with 422', async () => {
    const mara = await login(MARA);
    const cust = await matterByKey(mara, 'MAT-2026-014');
    const res = await request(app)
      .post(`/api/matters/${cust.id}/documents?title=Empty&filename=empty.txt`)
      .set('Cookie', mara)
      .set('Content-Type', 'text/plain')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(422);
  });
});

describe('tags', () => {
  it('an editor adds a tag and it filters document lists; a viewer cannot edit tags', async () => {
    const mara = await login(MARA); // owner on 014
    const admin = await login(ADMIN);
    const cust = await matterByKey(admin, 'MAT-2026-014');
    const doc = (await docsIn(admin, cust.id)).find((d) => d.title === 'Cap Table')!;

    const add = await request(app).post(`/api/documents/${doc.id}/tags`).set('Cookie', mara).send({ tag: 'q1-review' });
    expect(add.status).toBe(201);
    expect((add.body.document as DocumentSummary).tags).toContain('q1-review');

    const filtered = await request(app).get('/api/documents?tag=q1-review').set('Cookie', mara);
    expect(filtered.status).toBe(200);
    expect((filtered.body.documents as DocumentSummary[]).map((d) => d.id)).toContain(doc.id);

    // A viewer on MAT-2026-033 cannot edit tags there → 403.
    const maraViewerDoc = (await docsIn(admin, (await matterByKey(admin, 'MAT-2026-033')).id))[0]!;
    const denied = await request(app)
      .post(`/api/documents/${maraViewerDoc.id}/tags`)
      .set('Cookie', mara)
      .send({ tag: 'nope' });
    expect(denied.status).toBe(403);
  });
});

describe('soft delete', () => {
  it('hides the document from lists and reads but retains version history', async () => {
    const iris = await login(IRIS); // owner on MAT-2026-033
    const admin = await login(ADMIN);
    const helios = await matterByKey(admin, 'MAT-2026-033');
    const doc = (await docsIn(admin, helios.id)).find((d) => d.title === 'Onboarding Checklist')!;
    const countVersions = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?').get(doc.id) as {
        n: number;
      }).n;
    const versionsBefore = countVersions();
    expect(versionsBefore).toBeGreaterThan(0);

    const del = await request(app).delete(`/api/documents/${doc.id}`).set('Cookie', iris);
    expect(del.status).toBe(200);

    // Gone from lists and reads for everyone, including admin.
    expect((await docsIn(admin, helios.id)).some((d) => d.id === doc.id)).toBe(false);
    expect((await request(app).get(`/api/documents/${doc.id}`).set('Cookie', admin)).status).toBe(404);
    expect((await request(app).get(`/api/documents/${doc.id}/download`).set('Cookie', admin)).status).toBe(404);

    // History is retained in the database: version rows are untouched, and
    // the document row still exists but is flagged deleted.
    expect(countVersions()).toBe(versionsBefore);
    const row = db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(doc.id) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
  });
});

describe('password change', () => {
  it('bumps token version: old session and old password die, new ones work', async () => {
    const creds = { username: 'iris', password: 'demo-iris' };
    const oldCookie = await login(creds);
    const res = await request(app)
      .post('/api/me/password')
      .set('Cookie', oldCookie)
      .send({ currentPassword: creds.password, newPassword: 'iris-new-password' });
    expect(res.status).toBe(200);
    const freshCookie = res.headers['set-cookie']![0]!.split(';')[0]!;

    expect((await request(app).get('/api/me').set('Cookie', oldCookie)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Cookie', freshCookie)).status).toBe(200);
    expect((await request(app).post('/api/login').send(creds)).status).toBe(401);
    expect(
      (await request(app).post('/api/login').send({ username: 'iris', password: 'iris-new-password' })).status,
    ).toBe(200);
  });
});

describe('admin management', () => {
  it('only admins create matters and users', async () => {
    const mara = await login(MARA);
    expect((await request(app).post('/api/matters').set('Cookie', mara).send({ key: 'MAT-X', name: 'x' })).status).toBe(403);
    expect(
      (await request(app).post('/api/users').set('Cookie', mara).send({ username: 'x', name: 'X', password: 'password123' })).status,
    ).toBe(403);

    const admin = await login(ADMIN);
    const created = await request(app)
      .post('/api/matters')
      .set('Cookie', admin)
      .send({ key: 'MAT-2026-099', name: 'New Matter', description: 'created in test' });
    expect(created.status).toBe(201);
    expect((created.body.matter as MatterSummary).role).toBe('owner');
  });
});
