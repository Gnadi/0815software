import { BaseClient } from './http.js';
import type { RunWorkflowInput, WorkflowEvent, WorkflowInstance } from './types.js';
/** Client for PS-02 Workflow Engine (default port 4002). */
export declare class WorkflowClient extends BaseClient {
    /** Ingest a domain event (service-token auth); may fan out to triggers. */
    emit(event: WorkflowEvent): Promise<{
        accepted: boolean;
        started: number;
    }>;
    /** Start a workflow instance directly; idempotent on `idempotency_key`. */
    run(key: string, input?: RunWorkflowInput): Promise<WorkflowInstance>;
    getInstance(id: string): Promise<WorkflowInstance & {
        transitions: string[];
    }>;
    advance(id: string, step: string): Promise<WorkflowInstance>;
}
