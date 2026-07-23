/**
 * PS-02 Workflow Engine — wire contract shared between server and client.
 */

export const TRIGGER_TYPES = ['event', 'schedule', 'webhook', 'manual'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const WORKFLOW_EVENT_TYPES = [
  'created',
  'step_entered',
  'step_completed',
  'step_failed',
  'completed',
  'failed',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export const INSTANCE_STATUSES = ['running', 'completed', 'failed'] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isTriggerType(v: string): v is TriggerType {
  return (TRIGGER_TYPES as readonly string[]).includes(v);
}

/** A workflow's steps and the legal transitions between them. */
export interface WorkflowDefinitionBody {
  initial: string;
  steps: string[];
  transitions: Record<string, string[]>;
  terminal: string[];
}

export interface WorkflowDefinition {
  id: number;
  key: string;
  version: number;
  name: string;
  definition: WorkflowDefinitionBody;
  enabled: boolean;
  created_at: string;
}

export interface Trigger {
  id: number;
  workflow_key: string;
  type: TriggerType;
  config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

export interface WorkflowEvent {
  id: number;
  type: WorkflowEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface InstanceState {
  current_step: string | null;
  status: InstanceStatus;
  allowed_transitions: string[];
}

export interface InstanceSummary {
  id: number;
  workflow_key: string;
  workflow_version: number;
  idempotency_key: string | null;
  created_at: string;
  current_step: string | null;
  status: InstanceStatus;
}

export interface InstanceDetail extends InstanceSummary {
  input: Record<string, unknown>;
  events: WorkflowEvent[];
  allowed_transitions: string[];
}

export interface Webhook {
  id: number;
  event_type: string;
  url: string;
  active: boolean;
  created_at: string;
}

export interface Delivery {
  id: number;
  webhook_id: number;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  response_status: number | null;
  created_at: string;
  updated_at: string;
}

export interface FieldError {
  field: string;
  message: string;
}
