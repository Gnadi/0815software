import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { createParty, getSelf, listParties, putSelf, cleanInput } from '../server/parties.js';

/**
 * PS-11 was missing from `deploy/backup.sh` — the loop ran ps01…ps10 — so the
 * one service holding every counterparty, their VAT ids and bank details, plus
 * the stack owner's own seller identity, was the one nothing snapshotted.
 *
 * This exercises the script the container runs, then restores from it.
 */

let work: string;
let dbPath: string;
let backupDir: string;
let db: Database.Database;

function runBackup(): string {
  execFileSync(process.execPath, ['scripts/backup.mjs'], {
    env: { ...process.env, DATABASE_PATH: dbPath, BACKUP_DIR: backupDir },
    encoding: 'utf8',
  });
  const snapshot = readdirSync(backupDir).find((f) => f.endsWith('.db'));
  expect(snapshot).toBeDefined();
  return join(backupDir, snapshot!);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ps11-backup-'));
  dbPath = join(work, 'data.db');
  backupDir = join(work, 'backups');
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('brings back the parties and the seller identity', () => {
    putSelf(db, { name: '0815software GmbH', vat_id: 'ATU00000000', iban: 'AT00 0000 0000 0000 0000' });
    createParty(db, cleanInput({ name: 'Blaustern GmbH', kind: 'customer', vat_id: 'ATU11111111' }));
    createParty(db, cleanInput({ name: 'Nordwind AG', kind: 'supplier', email: 'ap@nordwind.test' }));

    const snapshot = runBackup();

    db.close();
    rmSync(dbPath);
    db = openDb(dbPath);
    expect(listParties(db)).toHaveLength(0); // a fresh, empty database
    db.close();

    copyFileSync(snapshot, dbPath);
    db = openDb(dbPath);

    expect(getSelf(db)?.vat_id).toBe('ATU00000000');
    expect(listParties(db, { kind: 'customer' }).map((p) => p.name)).toEqual(['Blaustern GmbH']);
    expect(listParties(db, { kind: 'supplier' }).map((p) => p.name)).toEqual(['Nordwind AG']);
  });
});
