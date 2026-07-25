import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { SyncJob, SyncStatus } from '../shared/types.js';
import { nowIso } from './auth.js';

/**
 * Outbound sync jobs: a job is created `pending`, then advanced by the
 * scheduler on `POST /api/tick`. The actual data pull is delegated to a
 * per-provider adapter; the built-in default is a deterministic mock adapter
 * that "pulls" a fixed set of records offline, so the pipeline (pending →
 * running → done) is exercised with zero external calls. A real deployment
 * registers provider adapters that fetch live data.
 */

interface SyncJobRow {
  id: number;
  connection_id: number;
  kind: string;
  status: string;
  cursor: string | null;
  records: number;
  created_at: string;
  updated_at: string;
}

export function mapSyncJob(row: SyncJobRow): SyncJob & { records: number } {
  return {
    id: row.id,
    connection_id: row.connection_id,
    kind: row.kind,
    status: row.status as SyncStatus,
    cursor: row.cursor,
    records: row.records ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A sync adapter pulls records for a (connection, kind) and returns a result. */
export interface SyncAdapter {
  pull(job: { connectionId: number; kind: string; cursor: string | null }): { records: number; cursor: string };
}

/** Deterministic offline adapter: record count derived from the kind. */
export const mockSyncAdapter: SyncAdapter = {
  pull({ connectionId, kind }) {
    const digest = createHash('sha256').update(`${connectionId}:${kind}`).digest();
    const records = (digest[0]! % 5) + 1; // 1..5 deterministic records
    return { records, cursor: `mock-cursor-${digest.toString('hex').slice(0, 8)}` };
  },
};

/** Advance every pending sync job once. Returns how many jobs ran. */
export function runSyncJobs(db: Database.Database, adapter: SyncAdapter = mockSyncAdapter, now = Date.now()): number {
  const pending = db.prepare(`SELECT * FROM sync_jobs WHERE status = 'pending' ORDER BY id`).all() as SyncJobRow[];
  let ran = 0;
  for (const job of pending) {
    db.prepare(`UPDATE sync_jobs SET status = 'running', updated_at = ? WHERE id = ?`).run(nowIso(now), job.id);
    try {
      const result = adapter.pull({ connectionId: job.connection_id, kind: job.kind, cursor: job.cursor });
      db.prepare(`UPDATE sync_jobs SET status = 'done', cursor = ?, records = ?, updated_at = ? WHERE id = ?`).run(
        result.cursor,
        result.records,
        nowIso(now),
        job.id,
      );
    } catch {
      db.prepare(`UPDATE sync_jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(nowIso(now), job.id);
    }
    ran++;
  }
  return ran;
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
