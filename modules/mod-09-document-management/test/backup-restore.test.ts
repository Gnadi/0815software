import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Database } from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import type { MatterSummary } from '../shared/types.js';

/**
 * Backup and restore for the module where a database-only snapshot would lie.
 *
 * Documents live on disk; the database holds their metadata. Backing up only
 * the database would restore a catalogue of files that are gone — the failure
 * mode nobody notices until the day they need the file. So the script copies
 * the storage directory too, and this test destroys BOTH and reads the bytes
 * back out through the download route afterwards.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 1, secureCookie: false };
const ADMIN = { username: 'admin', password: 'demo-admin' };
const CONTENT = Buffer.from('Vertragsentwurf — bitte gegenzeichnen.\n');

let work: string;
let dbPath: string;
let storageDir: string;
let backupDir: string;
let db: Database;

function runBackup(): { snapshot: string; storage: string } {
  execFileSync(process.execPath, ['scripts/backup.mjs'], {
    env: { ...process.env, DATABASE_PATH: dbPath, BACKUP_DIR: backupDir, STORAGE_DIR: storageDir },
    encoding: 'utf8',
  });
  const entries = readdirSync(backupDir);
  const snapshot = entries.find((e) => e.endsWith('.db'));
  const storage = entries.find((e) => e.startsWith('storage-'));
  expect(snapshot, 'a database snapshot').toBeDefined();
  expect(storage, 'a copy of the storage directory').toBeDefined();
  return { snapshot: join(backupDir, snapshot!), storage: join(backupDir, storage!) };
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'mod09-backup-'));
  dbPath = join(work, 'data.db');
  storageDir = join(work, 'storage');
  backupDir = join(work, 'backups');
  db = openDb(dbPath);
  await seed(db, storageDir);
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('brings back the document bytes, not just their metadata', async () => {
    const app = createApp({ db, session, storageDir });
    const login = await request(app).post('/api/login').send(ADMIN);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    const matters = (await request(app).get('/api/matters').set('Cookie', cookie)).body
      .matters as MatterSummary[];
    const uploaded = await request(app)
      .post(`/api/matters/${matters[0]!.id}/documents?title=Vertrag&filename=vertrag.txt`)
      .set('Cookie', cookie)
      .set('Content-Type', 'text/plain')
      .send(CONTENT);
    expect(uploaded.status).toBe(201);
    const docId = uploaded.body.document.id as number;

    const { snapshot, storage } = runBackup();

    // Lose everything: the database AND the files it points at.
    db.close();
    rmSync(dbPath);
    rmSync(storageDir, { recursive: true, force: true });

    // Restore both halves, which is what the module's README now tells you.
    copyFileSync(snapshot, dbPath);
    cpSync(storage, storageDir, { recursive: true });
    db = openDb(dbPath);

    const restored = createApp({ db, session, storageDir });
    const after = await request(restored).post('/api/login').send(ADMIN);
    const cookie2 = after.headers['set-cookie']![0]!.split(';')[0]!;

    const download = await request(restored)
      .get(`/api/documents/${docId}/download`)
      .set('Cookie', cookie2)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(CONTENT)).toBe(true);
  });

  it('would have restored a catalogue of missing files without the storage copy', async () => {
    // The point of copying the directory, stated as a test: with only the
    // database back, the metadata is there and the bytes are not.
    const app = createApp({ db, session, storageDir });
    const login = await request(app).post('/api/login').send(ADMIN);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    const matters = (await request(app).get('/api/matters').set('Cookie', cookie)).body
      .matters as MatterSummary[];
    const uploaded = await request(app)
      .post(`/api/matters/${matters[0]!.id}/documents?title=Vertrag&filename=vertrag.txt`)
      .set('Cookie', cookie)
      .set('Content-Type', 'text/plain')
      .send(CONTENT);
    const docId = uploaded.body.document.id as number;

    const { snapshot } = runBackup();
    db.close();
    rmSync(dbPath);
    rmSync(storageDir, { recursive: true, force: true });
    copyFileSync(snapshot, dbPath); // database only, on purpose
    db = openDb(dbPath);

    const restored = createApp({ db, session, storageDir });
    const after = await request(restored).post('/api/login').send(ADMIN);
    const cookie2 = after.headers['set-cookie']![0]!.split(';')[0]!;

    const listed = await request(restored).get(`/api/documents/${docId}`).set('Cookie', cookie2);
    expect(listed.status).toBe(200); // the record survived…
    const download = await request(restored).get(`/api/documents/${docId}/download`).set('Cookie', cookie2);
    expect(download.status).not.toBe(200); // …the file did not
  });
});
