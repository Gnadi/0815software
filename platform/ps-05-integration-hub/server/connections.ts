import type Database from 'better-sqlite3';
import type { Connection, ConnectionStatus } from '../shared/types.js';
import { nowIso } from './auth.js';
import { decrypt, encrypt } from './crypto.js';

export interface ConnectionRow {
  id: number;
  provider: string;
  name: string;
  status: string;
  credentials_encrypted: string;
  scopes: string;
  external_account: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Map to the wire shape — the encrypted credentials are dropped. */
export function mapConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    status: row.status as ConnectionStatus,
    scopes: row.scopes,
    external_account: row.external_account,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function connectionEvent(db: Database.Database, connectionId: number, type: string, meta: Record<string, unknown>, now: number): void {
  db.prepare('INSERT INTO connection_events (connection_id, type, meta, created_at) VALUES (?, ?, ?, ?)').run(
    connectionId,
    type,
    JSON.stringify(meta),
    nowIso(now),
  );
}

export function createConnection(
  db: Database.Database,
  encKey: Buffer,
  opts: {
    provider: string;
    name: string;
    credentials: Record<string, unknown>;
    scopes?: string;
    externalAccount?: string | null;
    expiresAt?: string | null;
  },
  now = Date.now(),
): ConnectionRow {
  const at = nowIso(now);
  const blob = encrypt(encKey, JSON.stringify(opts.credentials));
  const created = db.transaction((): ConnectionRow => {
    const info = db
      .prepare(
        `INSERT INTO connections (provider, name, status, credentials_encrypted, scopes, external_account, expires_at, created_at, updated_at)
         VALUES (?, ?, 'connected', ?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.provider, opts.name, blob, opts.scopes ?? '', opts.externalAccount ?? null, opts.expiresAt ?? null, at, at);
    const id = Number(info.lastInsertRowid);
    connectionEvent(db, id, 'connected', { provider: opts.provider }, now);
    return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow;
  })();
  return created;
}

/** Decrypt and parse the stored credentials for internal use only. */
export function credentialsOf(encKey: Buffer, row: ConnectionRow): Record<string, unknown> {
  return JSON.parse(decrypt(encKey, row.credentials_encrypted)) as Record<string, unknown>;
}
