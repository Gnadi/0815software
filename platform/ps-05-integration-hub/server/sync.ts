import type Database from 'better-sqlite3';
import type { SyncJob, SyncStatus } from '../shared/types.js';
import { nowIso } from './auth.js';

/**
 * Outbound sync jobs are stubs in v1: a job can be created and listed, but
 * the actual data pull is the documented integration point a real
 * deployment would implement per provider.
 */

interface SyncJobRow {
  id: number;
  connection_id: number;
  kind: string;
  status: string;
  cursor: string | null;
  created_at: string;
  updated_at: string;
}

export function mapSyncJob(row: SyncJobRow): SyncJob {
  return {
    id: row.id,
    connection_id: row.connection_id,
    kind: row.kind,
    status: row.status as SyncStatus,
    cursor: row.cursor,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createSyncJob(db: Database.Database, connectionId: number, kind: string, now = Date.now()): SyncJobRow {
  const at = nowIso(now);
  const info = db
    .prepare(`INSERT INTO sync_jobs (connection_id, kind, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`)
    .run(connectionId, kind, at, at);
  return db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(info.lastInsertRowid) as SyncJobRow;
}

export function listSyncJobs(db: Database.Database): SyncJobRow[] {
  return db.prepare('SELECT * FROM sync_jobs ORDER BY id DESC').all() as SyncJobRow[];
}
