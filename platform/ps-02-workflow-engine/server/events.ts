import type Database from 'better-sqlite3';
import type { WorkflowDefinitionBody } from '../shared/types.js';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import {
  allowedTransitions,
  currentDefinition,
  deriveCurrentStep,
  deriveStatus,
  instanceEvents,
  type InstanceRow,
  type WorkflowDefRow,
} from './workflows.js';
import { enqueueDeliveries } from './webhooks.js';

export function appendEvent(
  db: Database.Database,
  instanceId: number,
  type: string,
  payload: Record<string, unknown>,
  now = Date.now(),
): void {
  db.prepare(
    'INSERT INTO workflow_events (instance_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
  ).run(instanceId, type, JSON.stringify(payload), nowIso(now));
}

export interface StartResult {
  instance: InstanceRow;
  created: boolean;
}

/**
 * Start a workflow instance. With an idempotency key, a replay carrying
 * the same input returns the existing instance (created: false); a replay
 * with a different input is a 409 conflict.
 */
export function startInstance(
  db: Database.Database,
  opts: {
    key: string;
    input?: Record<string, unknown>;
    idempotencyKey?: string | null;
    triggerId?: number | null;
    now?: number;
  },
): StartResult {
  const now = opts.now ?? Date.now();
  const input = opts.input ?? {};
  const idempotencyKey = opts.idempotencyKey ?? null;

  const defRow = currentDefinition(db, opts.key);
  if (!defRow) throw new DomainError(404, `Unknown workflow "${opts.key}"`);
  if (defRow.enabled !== 1) throw new DomainError(422, `Workflow "${opts.key}" is disabled`);
  const def = JSON.parse(defRow.definition) as WorkflowDefinitionBody;

  if (idempotencyKey !== null) {
    const existing = db
      .prepare('SELECT * FROM workflow_instances WHERE workflow_key = ? AND idempotency_key = ?')
      .get(opts.key, idempotencyKey) as InstanceRow | undefined;
    if (existing) {
      if (existing.input !== JSON.stringify(input)) {
        throw new DomainError(409, 'Idempotency key already used with a different input');
      }
      return { instance: existing, created: false };
    }
  }

  const instance = db.transaction((): InstanceRow => {
    const info = db
      .prepare(
        `INSERT INTO workflow_instances
           (workflow_key, workflow_version, trigger_id, idempotency_key, input, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.key, defRow.version, opts.triggerId ?? null, idempotencyKey, JSON.stringify(input), nowIso(now));
    const id = Number(info.lastInsertRowid);
    appendEvent(db, id, 'created', {}, now);
    appendEvent(db, id, 'step_entered', { step: def.initial }, now);
    if (def.terminal.includes(def.initial)) appendEvent(db, id, 'completed', {}, now);
    return db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(id) as InstanceRow;
  })();

  return { instance, created: true };
}

/** Advance a running instance to `toStep`; illegal transitions are 422. */
export function advanceInstance(
  db: Database.Database,
  instance: InstanceRow,
  toStep: string,
  now = Date.now(),
): void {
  const defRow = db
    .prepare('SELECT * FROM workflow_definitions WHERE key = ? AND version = ?')
    .get(instance.workflow_key, instance.workflow_version) as WorkflowDefRow | undefined;
  if (!defRow) throw new DomainError(404, 'Workflow definition not found');
  const def = JSON.parse(defRow.definition) as WorkflowDefinitionBody;

  const events = instanceEvents(db, instance.id);
  const status = deriveStatus(events);
  const currentStep = deriveCurrentStep(events);
  if (status !== 'running') throw new DomainError(409, 'Instance is already terminal');

  const allowed = allowedTransitions(def, currentStep, status);
  if (!allowed.includes(toStep)) {
    throw new DomainError(422, `Illegal transition from "${currentStep}" to "${toStep}"`);
  }

  db.transaction(() => {
    appendEvent(db, instance.id, 'step_completed', { step: currentStep }, now);
    appendEvent(db, instance.id, 'step_entered', { step: toStep }, now);
    if (def.terminal.includes(toStep)) appendEvent(db, instance.id, 'completed', {}, now);
  })();
}

export interface IngestResult {
  matched: number;
  instance_ids: number[];
  enqueued: number;
}

interface TriggerRow {
  id: number;
  workflow_key: string;
  type: string;
  config: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

/**
 * Ingest an external event: start an instance for every enabled trigger whose
 * type is in `matchTypes` and whose configured event name matches, and enqueue
 * a delivery for every webhook subscribed to that event type. `/api/events`
 * matches `event` triggers; the inbound hook receiver additionally matches
 * `webhook` triggers.
 */
export function ingestEvent(
  db: Database.Database,
  opts: {
    type: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string | null;
    matchTypes?: readonly ('event' | 'webhook')[];
    now?: number;
  },
): IngestResult {
  const now = opts.now ?? Date.now();
  const payload = opts.payload ?? {};
  const matchTypes = opts.matchTypes ?? ['event'];
  const placeholders = matchTypes.map(() => '?').join(', ');
  const triggers = db
    .prepare(`SELECT * FROM triggers WHERE type IN (${placeholders}) AND enabled = 1`)
    .all(...matchTypes) as TriggerRow[];

  const instanceIds: number[] = [];
  for (const trigger of triggers) {
    const config = JSON.parse(trigger.config) as { event?: string };
    if (config.event !== opts.type) continue;
    const started = startInstance(db, {
      key: trigger.workflow_key,
      input: payload,
      idempotencyKey: opts.idempotencyKey ?? null,
      triggerId: trigger.id,
      now,
    });
    instanceIds.push(started.instance.id);
  }

  const enqueued = enqueueDeliveries(db, opts.type, payload, now);
  return { matched: instanceIds.length, instance_ids: instanceIds, enqueued };
}
