import { BaseClient } from './http.js';
import type { RunWorkflowInput, WorkflowEvent, WorkflowInstance } from './types.js';

/** Client for PS-02 Workflow Engine (default port 4002). */
export class WorkflowClient extends BaseClient {
  /** Ingest a domain event (service-token auth); may fan out to triggers. */
  emit(event: WorkflowEvent): Promise<{ accepted: boolean; started: number }> {
    return this.apiPost('/api/events', event);
  }

  /** Start a workflow instance directly; idempotent on `idempotency_key`. */
  run(key: string, input: RunWorkflowInput = {}): Promise<WorkflowInstance> {
    return this.apiPost<WorkflowInstance>(`/api/workflows/${encodeURIComponent(key)}/run`, input);
  }

  getInstance(id: string): Promise<WorkflowInstance & { transitions: string[] }> {
    return this.apiGet(`/api/instances/${encodeURIComponent(id)}`);
  }

  advance(id: string, step: string): Promise<WorkflowInstance> {
    return this.apiPost<WorkflowInstance>(`/api/instances/${encodeURIComponent(id)}/advance`, { step });
  }
}
