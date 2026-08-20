/**
 * @0815software/platform-clients
 *
 * Typed HTTP clients for the 0815software Platform Services. A module
 * constructs the clients it needs, points them at the service URLs, and
 * presents its service token — never re-implementing auth, retries or
 * transport. All clients share one `fetch` seam so tests stay offline.
 */
export { BaseClient, ServiceError } from './http.js';
export type { ClientOptions, FetchLike } from './http.js';
export * from './types.js';

export { IdentityClient } from './identity.js';
export { WorkflowClient } from './workflow.js';
export { NotificationClient } from './notification.js';
export { AiClient } from './ai.js';
export { IntegrationClient } from './integration.js';
export { FilesClient } from './files.js';
export { AuditClient } from './audit.js';
export { PaymentsClient } from './payments.js';
export { SearchClient } from './search.js';
export type { IndexDocInput, SearchHit, SearchResult } from './search.js';
export { NumberClient } from './number.js';
export type { NextNumber, SequenceConfig } from './number.js';
export { CustomersClient } from './customers.js';
export type {
  MatchedOn,
  MergeResult,
  Party,
  PartyInput,
  PartyKind,
  PartyRef,
  ResolveInput,
  ResolveResult,
} from './customers.js';

export { BankingClient } from './banking.js';
export type {
  BankOrder,
  BankOrderStatus,
  BankProfile,
  Btf,
  OrderPreview,
  SubmitOrderInput,
} from './banking.js';
