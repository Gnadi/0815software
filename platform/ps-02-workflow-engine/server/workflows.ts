import type Database from 'better-sqlite3';
import type {
  InstanceStatus,
  WorkflowDefinition,
  WorkflowDefinitionBody,
  WorkflowEvent,
} from '../shared/types.js';
import { DomainError } from './errors.js';

// ── Row shapes ─────────────────────────────────────────────────────────

export interface WorkflowDefRow {
  id: number;
  key: string;
  version: number;
  name: string;
  definition: string;
  enabled: number;
  created_at: string;
}

export interface InstanceRow {
  id: number;
  workflow_key: string;
  workflow_version: number;
  trigger_id: number | null;
  idempotency_key: string | null;
  input: string;
  created_at: string;
}

export interface WorkflowEventRow {
  id: number;
  instance_id: number;
  type: string;
  payload: string;
  created_at: string;
}

export function mapDefinition(row: WorkflowDefRow): WorkflowDefinition {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    definition: JSON.parse(row.definition) as WorkflowDefinitionBody,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

export function mapEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    type: row.type as WorkflowEvent['type'],
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

// ── Definition validation ──────────────────────────────────────────────

/** Parse and validate a workflow definition body; throws 422 on any flaw. */
export function validateDefinition(raw: unknown): WorkflowDefinitionBody {
  const def = raw as Partial<WorkflowDefinitionBody> | undefined;
  const fail = (message: string): never => {
    throw new DomainError(422, 'Invalid workflow definition', [{ field: 'definition', message }]);
  };
  if (!def || typeof def !== 'object') fail('must be an object');
  const steps = def!.steps;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => typeof s === 'string')) {
    fail('steps must be a non-empty string array');
  }
  const stepSet = new Set(steps as string[]);
  if (typeof def!.initial !== 'string' || !stepSet.has(def!.initial)) fail('initial must be one of steps');
  const terminal = def!.terminal ?? [];
  if (!Array.isArray(terminal) || !terminal.every((s) => stepSet.has(s))) {
    fail('terminal steps must all be steps');
  }
  const transitions = def!.transitions ?? {};
  for (const [from, tos] of Object.entries(transitions)) {
    if (!stepSet.has(from)) fail(`transition from unknown step "${from}"`);
    if (!Array.isArray(tos) || !tos.every((s) => stepSet.has(s))) {
      fail(`transition targets from "${from}" must all be steps`);
    }
  }
  return {
    initial: def!.initial as string,
    steps: steps as string[],
    transitions: transitions as Record<string, string[]>,
    terminal: terminal as string[],
  };
}

/** The current version of a workflow (highest version number), or undefined. */
export function currentDefinition(db: Database.Database, key: string): WorkflowDefRow | undefined {
  return db
    .prepare('SELECT * FROM workflow_definitions WHERE key = ? ORDER BY version DESC LIMIT 1')
    .get(key) as WorkflowDefRow | undefined;
}

// ── Instance state, folded from the append-only event stream ───────────

export function deriveStatus(events: WorkflowEventRow[]): InstanceStatus {
  if (events.some((e) => e.type === 'completed')) return 'completed';
  if (events.some((e) => e.type === 'failed')) return 'failed';
  return 'running';
}

export function deriveCurrentStep(events: WorkflowEventRow[]): string | null {
  let step: string | null = null;
  for (const e of events) {
    if (e.type === 'step_entered') {
      step = (JSON.parse(e.payload) as { step?: string }).step ?? step;
    }
  }
  return step;
}

export function allowedTransitions(
  def: WorkflowDefinitionBody,
  currentStep: string | null,
  status: InstanceStatus,
): string[] {
  if (status !== 'running' || currentStep === null) return [];
  return def.transitions[currentStep] ?? [];
}

export function instanceEvents(db: Database.Database, instanceId: number): WorkflowEventRow[] {
  return db
    .prepare('SELECT * FROM workflow_events WHERE instance_id = ? ORDER BY created_at, id')
    .all(instanceId) as WorkflowEventRow[];
}
