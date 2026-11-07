import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import { readSettings, recordEvent } from './notify.js';

/**
 * The stack telling its administrators about itself: a service that stopped
 * answering (Prometheus → Alertmanager → here), a nightly backup that failed
 * (deploy/backup.sh → here). To the stack's `ops_recipients`, now and through
 * quiet hours — an outage at 2 a.m. is the case on-call exists for.
 *
 * In ADDITION to the operator's own alert channel, never instead of it: an
 * alerting path that runs only through the system it watches goes quiet
 * exactly when it is needed (the generated monitoring/alertmanager.yml says
 * the same). This one puts it on the phone of whoever runs the company's
 * stack, while the stack is alive enough to do so.
 */

export interface OpsEvent {
  kind: string;
  title: string;
  detail: string | null;
  key: string;
  resolved?: boolean;
}

export function recordOps(db: Database.Database, event: OpsEvent, now: number): { recorded: number; skipped: number } {
  const recipients = readSettings(db).ops_recipients;
  if (recipients.length === 0) return { recorded: 0, skipped: 0 };
  return recordEvent(
    db,
    {
      module: 'operations',
      kind: event.kind.slice(0, 60),
      category: 'operations',
      urgency: event.resolved ? 'digest' : 'now',
      recipients,
      actor: null,
      title: event.title.slice(0, 140),
      detail: event.detail ? event.detail.slice(0, 600) : null,
      href: null,
      oncall: !event.resolved,
      security: false,
      idempotencyKey: event.key.slice(0, 200),
    },
    now,
  );
}

/** One `POST /api/ops/events` body (deploy/backup.sh). */
export function parseOps(body: Record<string, unknown>): OpsEvent {
  const kind = typeof body.kind === 'string' && /^[a-z0-9-]{1,60}$/.test(body.kind) ? body.kind : null;
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
  const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : null;
  if (!kind || !title || !key) {
    throw new DomainError(422, 'Validation failed', [{ field: 'kind', message: 'kind, title and key are required' }]);
  }
  return { kind, title, detail: typeof body.detail === 'string' ? body.detail : null, key };
}

interface AmAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  fingerprint?: string;
}

/** Alertmanager's webhook payload (version 4): one event per alert, firing or resolved. */
export function fromAlertmanager(body: Record<string, unknown>): OpsEvent[] {
  const alerts = Array.isArray(body.alerts) ? (body.alerts as AmAlert[]) : [];
  return alerts.slice(0, 50).map((a) => {
    const name = a.labels?.alertname ?? 'alert';
    const resolved = a.status === 'resolved';
    return {
      kind: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60) || 'alert',
      title: `${resolved ? 'Resolved' : 'Stack alert'}: ${a.annotations?.summary ?? name}`,
      detail: [a.labels?.instance, a.annotations?.description].filter(Boolean).join(' · ') || null,
      key: `alertmanager:${a.fingerprint ?? name}:${a.startsAt ?? ''}:${resolved ? 'resolved' : 'firing'}`,
      resolved,
    };
  });
}
