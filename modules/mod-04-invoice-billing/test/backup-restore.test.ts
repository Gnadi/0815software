import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

/**
 * Backup AND restore, against the script the container actually runs.
 *
 * A backup nobody has restored is a hope, not a backup — and this module holds
 * the data a customer would least like to lose. So the test drives
 * `scripts/backup.mjs` as a subprocess (the same command `deploy/backup.sh`
 * issues), destroys the database, puts the snapshot back, and reads the
 * invoices out again through the module's own accessors.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT00 0000 0000 0000 0000',
  bic: 'EXAMPLEX',
};

let work: string;
let dbPath: string;
let backupDir: string;
let db: Database.Database;

/** Run the real backup script exactly as the container does. */
function runBackup(): string[] {
  execFileSync(process.execPath, ['scripts/backup.mjs'], {
    env: { ...process.env, DATABASE_PATH: dbPath, BACKUP_DIR: backupDir },
    encoding: 'utf8',
  });
  return readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort();
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mod04-backup-'));
  dbPath = join(work, 'data.db');
  backupDir = join(work, 'backups');
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('brings an issued invoice back after the database is destroyed', async () => {
    const app = createApp({ db, auth, seller });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    const customer = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Blaustern GmbH', email: 'buchhaltung@blaustern.test' });
    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({
        customer_id: customer.body.id,
        lines: [{ description: 'Beratung', quantity: 3, unit_price_cents: 15_000, vat_rate: 20 }],
      });
    const issued = await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie);
    expect(issued.status).toBe(200);
    const number = issued.body.number as string;
    const gross = issued.body.gross_cents as number;
    expect(number).toBeTruthy();

    const snapshots = runBackup();
    expect(snapshots).toHaveLength(1);

    // The disaster: the live database is replaced with rubbish while the
    // module is stopped, which is what a bad disk or a bad deploy looks like.
    db.close();
    writeFileSync(dbPath, 'this is not a database');
    expect(() => openDb(dbPath)).toThrow();

    // The restore, exactly as the README describes it: put the snapshot back.
    copyFileSync(join(backupDir, snapshots[0]!), dbPath);
    db = openDb(dbPath);

    const restored = createApp({ db, auth, seller });
    const after = await request(restored).post('/api/login').send({ username: 'admin', password: 'test-password' });
    const cookie2 = after.headers['set-cookie']![0]!.split(';')[0]!;
    const list = await request(restored).get('/api/invoices').set('Cookie', cookie2);
    expect(list.status).toBe(200);

    const invoice = (list.body.invoices as { number: string | null; gross_cents: number }[]).find(
      (row) => row.number === number,
    );
    expect(invoice).toBeDefined();
    expect(invoice!.gross_cents).toBe(gross);

    // And the restored database is a working one, not just a readable file:
    // the next number continues the sequence instead of colliding.
    const next = await request(restored)
      .post('/api/invoices')
      .set('Cookie', cookie2)
      .send({
        customer_id: customer.body.id,
        lines: [{ description: 'Mehr Beratung', quantity: 1, unit_price_cents: 5_000, vat_rate: 20 }],
      });
    const nextIssued = await request(restored).post(`/api/invoices/${next.body.id}/finalize`).set('Cookie', cookie2);
    expect(nextIssued.status).toBe(200);
    expect(nextIssued.body.number).not.toBe(number);
  });

  it('refuses to pretend when there is nothing to back up', () => {
    // A missing database must fail loudly: a silent success would leave the
    // operator believing in a snapshot that does not exist.
    rmSync(dbPath);
    expect(() => runBackup()).toThrow();
  });
});
