#!/usr/bin/env node
/**
 * Online, consistent SQLite backup via better-sqlite3's backup API.
 *   DATABASE_PATH  source database   (default ./data.db)
 *   BACKUP_DIR     snapshot target   (default ./backups)
 *
 * Restore = stop the module, put back both the snapshot and the files
 * directory beside it, start it again; pending migrations apply on boot.
 *
 * The snapshot lands on the SAME volume as the source by default, which
 * protects against a bad deploy but not against losing the volume — copy
 * BACKUP_DIR off the host too, which is what deploy/backup.sh is for.
 */
import Database from 'better-sqlite3';
import { mkdirSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const src = process.env.DATABASE_PATH ?? './data.db';
const dir = process.env.BACKUP_DIR ?? './backups';
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = join(dir, `backup-${stamp}.db`);

const db = new Database(src, { readonly: true, fileMustExist: true });
await db.backup(dest);
db.close();
console.log(`[backup] ${src} -> ${dest}`);

// Customer documents live on disk, not in the database. They are copied alongside
// the snapshot, so one restore brings back a whole module — a database
// without its files would restore a catalogue of things that are gone.
const filesSrc = process.env.DOCUMENTS_DIR ?? './documents';
if (existsSync(filesSrc)) {
  const filesDest = join(dir, `documents-${stamp}`);
  cpSync(filesSrc, filesDest, { recursive: true });
  console.log(`[backup] ${filesSrc} -> ${filesDest}`);
}
