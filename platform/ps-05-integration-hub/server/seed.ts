import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { createConnection } from './connections.js';
import { storeWebhookEvent } from './webhooks.js';

/**
 * Idempotent demo data: a GitHub and a Stripe connection with dummy
 * credentials stored **encrypted**, a couple of inbound webhook events
 * (one valid, one invalid signature), and a sync job. Re-running is a
 * no-op once any connection exists.
 */
export function seed(db: Database.Database, encKey: Buffer): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number };
  if (existing.n > 0) return;

  const now = Date.now();

  const github = createConnection(
    db,
    encKey,
    { provider: 'github', name: 'github-org', credentials: { access_token: 'ghp_demo_token' }, scopes: 'repo,read:org', externalAccount: 'acme-inc' },
    now,
  );
  createConnection(
    db,
    encKey,
    { provider: 'stripe', name: 'stripe-live', credentials: { access_token: 'sk_test_demo' }, scopes: '', externalAccount: 'acct_demo' },
    now,
  );

  storeWebhookEvent(db, { provider: 'github', eventType: 'push', signatureValid: true, payload: JSON.stringify({ ref: 'refs/heads/main' }), now });
  storeWebhookEvent(db, { provider: 'stripe', eventType: 'charge.succeeded', signatureValid: false, payload: JSON.stringify({ id: 'evt_bad' }), now });

  db.prepare(`INSERT INTO sync_jobs (connection_id, kind, status, created_at, updated_at) VALUES (?, 'repos', 'pending', ?, ?)`).run(
    github.id,
    nowIso(now),
    nowIso(now),
  );

  console.log('[seed] inserted 2 connections (encrypted), 2 webhook events, 1 sync job');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db, config.encryptionKey);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
