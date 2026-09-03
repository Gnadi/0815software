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
  /** Triggers whose workflow is disabled or gone — reported, never fatal. */
  skipped: number;
  /** Starts that resolved to an instance this idempotency key already made. */
  replayed: number;
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
  const idempotencyKey = opts.idempotencyKey ?? null;
  const matchTypes = opts.matchTypes ?? ['event'];
  const placeholders = matchTypes.map(() => '?').join(', ');
  const triggers = db
    .prepare(`SELECT * FROM triggers WHERE type IN (${placeholders}) AND enabled = 1`)
    .all(...matchTypes) as TriggerRow[];

  // One event is one unit of work: either every matching trigger starts and
  // every webhook is enqueued, or nothing is. Without the transaction, a
  // trigger that fails halfway leaves the earlier instances started and the
  // caller holding an error, with no way to tell what did happen.
  return db.transaction((): IngestResult => {
    /**
     * Has this exact ingest already happened?
     *
     * The idempotency key used to reach only `startInstance`, which deduped
     * the workflow INSTANCES. The webhook fan-out ran unconditionally beside
     * it, so a caller whose POST timed out and was retried with the same key
     * got one instance and TWO deliveries to every subscriber — the same
     * "customer receives it twice" the tick serialisation exists to prevent,
     * arriving through the door the key was supposed to close.
     *
     * The claim is inside this transaction, so two concurrent replays cannot
     * both see it missing. An ingest with no key stays at-least-once by
     * design: there is nothing to recognise a repeat by.
     */
    const alreadyIngested =
      idempotencyKey !== null &&
      db.prepare('SELECT 1 FROM event_ingests WHERE key = ?').get(idempotencyKey) !== undefined;
    const instanceIds: number[] = [];
    let skipped = 0;
    let replayed = 0;
    for (const trigger of triggers) {
      const config = JSON.parse(trigger.config) as { event?: string };
      if (config.event !== opts.type) continue;
      // An enabled trigger pointing at a disabled or deleted workflow is a
      // configuration state, not a bad request: skip it and keep fanning out
      // rather than failing the whole ingest for the other subscribers.
      const defRow = currentDefinition(db, trigger.workflow_key);
      if (!defRow || defRow.enabled !== 1) {
        skipped += 1;
        continue;
      }
      const started = startInstance(db, {
        key: trigger.workflow_key,
        input: payload,
        idempotencyKey,
        triggerId: trigger.id,
        now,
      });
      // Two triggers on one workflow, ingested under a single idempotency
      // key, resolve to the SAME instance — the second start is a replay, not
      // a second run. Reporting it twice told the caller a fan-out happened
      // that never did, so the id is listed once and the replay is counted.
      if (!started.created) replayed += 1;
      if (!instanceIds.includes(started.instance.id)) instanceIds.push(started.instance.id);
    }

    const enqueued = alreadyIngested ? 0 : enqueueDeliveries(db, opts.type, payload, now);
    if (idempotencyKey !== null && !alreadyIngested) {
      db.prepare('INSERT INTO event_ingests (key, event_type, created_at) VALUES (?, ?, ?)').run(
        idempotencyKey,
        opts.type,
        nowIso(now),
      );
    }
    return { matched: instanceIds.length, instance_ids: instanceIds, enqueued, skipped, replayed };
  })();
}
