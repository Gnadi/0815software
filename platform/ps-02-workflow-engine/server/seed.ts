import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { advanceInstance, ingestEvent, startInstance } from './events.js';
import type { WorkflowDefinitionBody } from '../shared/types.js';

/**
 * Idempotent demo data: two workflows (a tiered invoice approval and a
 * ticket escalation), an event trigger, a schedule trigger, an outbound
 * webhook, a few instances with real histories, and one dead-lettered
 * delivery so the queue view has something to show. Re-running is a no-op
 * once any workflow exists.
 */

const INVOICE_APPROVAL: WorkflowDefinitionBody = {
  initial: 'submitted',
  steps: ['submitted', 'tier1_review', 'tier2_review', 'approved', 'rejected'],
  transitions: {
    submitted: ['tier1_review', 'rejected'],
    tier1_review: ['tier2_review', 'rejected'],
    tier2_review: ['approved', 'rejected'],
  },
  terminal: ['approved', 'rejected'],
};

const TICKET_ESCALATION: WorkflowDefinitionBody = {
  initial: 'open',
  steps: ['open', 'escalated', 'resolved'],
  transitions: {
    open: ['escalated', 'resolved'],
    escalated: ['resolved'],
  },
  terminal: ['resolved'],
};

export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM workflow_definitions').get() as { n: number };
  if (existing.n > 0) return;

  const now = Date.now();
  const at = nowIso(now);

  const defineWorkflow = (key: string, name: string, def: WorkflowDefinitionBody): void => {
    db.prepare(
      `INSERT INTO workflow_definitions (key, version, name, definition, enabled, created_at)
       VALUES (?, 1, ?, ?, 1, ?)`,
    ).run(key, name, JSON.stringify(def), at);
  };

  db.transaction(() => {
    defineWorkflow('invoice-approval', 'Invoice Approval', INVOICE_APPROVAL);
    defineWorkflow('ticket-escalation', 'Ticket Escalation', TICKET_ESCALATION);

    db.prepare(
      `INSERT INTO triggers (workflow_key, type, config, enabled, created_at) VALUES (?, 'event', ?, 1, ?)`,
    ).run('ticket-escalation', JSON.stringify({ event: 'ticket.created' }), at);

    db.prepare(
      `INSERT INTO triggers (workflow_key, type, config, enabled, created_at) VALUES (?, 'schedule', ?, 1, ?)`,
    ).run('invoice-approval', JSON.stringify({ interval_seconds: 3600 }), at);

    db.prepare(
      `INSERT INTO webhooks (event_type, url, secret, active, created_at) VALUES (?, ?, ?, 1, ?)`,
    ).run('ticket.created', 'https://example.invalid/hooks/tickets', 'seed-webhook-secret', at);
  })();

  // A fully-advanced invoice, driven through the domain functions.
  const invoice = startInstance(db, {
    key: 'invoice-approval',
    input: { invoice_no: 'INV-2026-0007', amount_cents: 480000 },
    now: now - 3 * 3600_000,
  });
  advanceInstance(db, invoice.instance, 'tier1_review', now - 2 * 3600_000);
  advanceInstance(db, invoice.instance, 'tier2_review', now - 3600_000);
  advanceInstance(db, invoice.instance, 'approved', now - 1800_000);

  // An ingested event: starts a ticket-escalation instance and enqueues a
  // delivery to the seeded webhook.
  ingestEvent(db, {
    type: 'ticket.created',
    payload: { ticket_ref: 'TKT-2026-0001', priority: 'high' },
    now: now - 600_000,
  });

  // One dead-lettered delivery so the queue view shows a terminal failure.
  db.prepare(
    `INSERT INTO webhook_deliveries
       (webhook_id, event_type, payload, status, attempts, next_attempt_at, last_error, response_status, created_at, updated_at)
     VALUES (1, 'ticket.created', ?, 'dead', 5, ?, 'HTTP 500', 500, ?, ?)`,
  ).run(JSON.stringify({ event_type: 'ticket.created', payload: { ticket_ref: 'TKT-2026-0000' } }), at, at, at);

  console.log('[seed] inserted 2 workflows, 2 triggers, 1 webhook, demo instances + deliveries');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
