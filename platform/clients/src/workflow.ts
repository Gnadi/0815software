import { BaseClient } from './http.js';
import type { IngestResult, RunWorkflowInput, WorkflowEvent, WorkflowInstanceDetail } from './types.js';

/** Client for PS-02 Workflow Engine (default port 4002). */
export class WorkflowClient extends BaseClient {
  /** Ingest a domain event (service-token auth); may fan out to triggers. */
  emit(event: WorkflowEvent): Promise<IngestResult> {
    return this.apiPost<IngestResult>('/api/events', event);
  }

  /** Start a workflow instance directly; idempotent on `idempotency_key`. */
  run(key: string, input: RunWorkflowInput = {}): Promise<{ instance: WorkflowInstanceDetail }> {
    return this.apiPost(`/api/workflows/${encodeURIComponent(key)}/run`, input);
  }

  getInstance(id: number | string): Promise<{ instance: WorkflowInstanceDetail }> {
    return this.apiGet(`/api/instances/${encodeURIComponent(String(id))}`);
  }

  /** Advance an instance to `toStep` (the service field is `to_step`). */
  advance(id: number | string, toStep: string): Promise<{ instance: WorkflowInstanceDetail }> {
    return this.apiPost(`/api/instances/${encodeURIComponent(String(id))}/advance`, { to_step: toStep });
  }
}
