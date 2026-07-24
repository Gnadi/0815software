#!/usr/bin/env node
/**
 * Online, consistent SQLite backup via better-sqlite3's backup API.
 *   DATABASE_PATH  source database   (default ./data.db)
 *   BACKUP_DIR     snapshot target   (default ./backups)
 * Restore = stop the service, replace DATABASE_PATH with a snapshot, start.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
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
