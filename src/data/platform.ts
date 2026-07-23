// Single source of truth for the Platform Services catalogue: the grid on
// platform.astro and the per-service detail pages (platform/[slug].astro).
// Platform Services are shared backend capabilities consumed by the
// Business Modules over APIs — see src/data/modules.ts for the modules.

const REPO = 'https://github.com/Gnadi/0815software/tree/main/platform';

export type ServiceStatus = 'Available' | 'Planned';

export interface PlatformService {
  n: string; // e.g. 'PS-01'
  slug: string; // URL slug, e.g. 'identity'
  folder: string; // repo folder under platform/
  title: string;
  purpose: string; // one-line catalogue blurb
  status: ServiceStatus;
  port: number; // default local API port
  source: string; // GitHub URL
  overview: string; // long paragraph
  responsibilities: string[];
  api: string[]; // representative endpoints
  consumers: string; // who calls it
}

export const platform: PlatformService[] = [
  {
    n: 'PS-01',
    slug: 'identity',
    folder: 'ps-01-identity',
    title: 'Identity',
    purpose: 'Shared authentication and authorization — one login, one set of users and roles, strict multi-tenancy.',
    status: 'Available',
    port: 4001,
    source: `${REPO}/ps-01-identity`,
    overview:
      'A single authority for identity and access across every module. Passwords are hashed with Node’s scrypt; sessions are stateless HMAC tokens with token-version revocation on password change; API keys authenticate machines. Every query is scoped to the caller’s organization, and a resource in another tenant returns 404, never 403. POST /api/tokens/verify is the contract other services use to check a caller’s identity.',
    responsibilities: [
      'Organizations (tenants), users, roles and a fine-grained permission catalog',
      'scrypt password hashing with constant-time unknown-account handling',
      'Stateless HMAC session tokens, revoked on password change',
      'Machine-to-machine API keys (scrypt-hashed, shown once)',
      'OAuth endpoints stubbed as the documented seam; multi-tenant isolation',
    ],
    api: [
      'POST /api/login · POST /api/logout',
      'GET /api/me · POST /api/tokens/verify',
      'GET/POST /api/users · POST /api/users/:id/password',
      'GET/POST /api/roles · GET /api/permissions',
      'GET/POST /api/api-keys · DELETE /api/api-keys/:id',
    ],
    consumers: 'Every module delegates authentication and authorization here.',
  },
  {
    n: 'PS-02',
    slug: 'workflow-engine',
    folder: 'ps-02-workflow-engine',
    title: 'Workflow Engine',
    purpose: 'Automation for all modules — workflows, triggers, events, scheduling, and reliable outbound webhooks.',
    status: 'Available',
    port: 4002,
    source: `${REPO}/ps-02-workflow-engine`,
    overview:
      'An event-sourced automation engine. Workflows are versioned definitions; instance state is folded from an append-only event stream at read time, so nothing can drift. Runs are idempotent, transitions are config-validated, and outbound webhooks are delivered with an HMAC signature, exponential backoff, and dead-lettering. A single POST /api/tick advances the scheduler and the delivery queue.',
    responsibilities: [
      'Versioned workflow definitions with config-validated transitions',
      'Append-only instances; current step and status derived at read time',
      'Idempotent runs; event, schedule, webhook and manual triggers',
      'Interval scheduler with no catch-up backfill',
      'Outbound webhooks with backoff and dead-lettering',
    ],
    api: [
      'GET/POST /api/workflows · POST /api/workflows/:key/run',
      'GET/POST /api/triggers',
      'GET /api/instances/:id · POST /api/instances/:id/advance',
      'GET/POST/DELETE /api/webhooks · GET /api/deliveries',
      'POST /api/events · POST /api/tick',
    ],
    consumers: 'Any module that needs automation, scheduling or event fan-out.',
  },
  {
    n: 'PS-03',
    slug: 'notification-hub',
    folder: 'ps-03-notification-hub',
    title: 'Notification Hub',
    purpose: 'Centralized notification delivery across email, SMS, push and chat, with templates and a retryable queue.',
    status: 'Available',
    port: 4003,
    source: `${REPO}/ps-03-notification-hub`,
    overview:
      'One place to compose, template, queue and deliver messages across every channel. Channels sit behind a provider abstraction whose default is a zero-external-call console provider; a channel whose real provider is unconfigured degrades to it gracefully. Templates are versioned with {{variable}} interpolation, and the message queue retries with backoff and dead-letters after exhausting attempts.',
    responsibilities: [
      'Channels for email, SMS, push, Slack, Teams, Discord and webhooks',
      'Provider abstraction with graceful degradation to a console no-op',
      'Versioned templates with variable interpolation and HTML escaping',
      'Retryable message queue with backoff and dead-lettering',
      'Idempotent sends; a preview endpoint that renders without sending',
    ],
    api: [
      'POST /api/send',
      'GET/POST /api/channels',
      'GET/POST /api/templates · POST /api/templates/:key/preview',
      'GET /api/messages · POST /api/messages/:id/retry',
      'POST /api/tick',
    ],
    consumers: 'Any module that needs to notify a person or an external system.',
  },
  {
    n: 'PS-04',
    slug: 'ai-platform',
    folder: 'ps-04-ai-platform',
    title: 'AI Platform',
    purpose: 'Shared AI capabilities — chat, embeddings, RAG and prompt management behind one provider-agnostic API.',
    status: 'Available',
    port: 4004,
    source: `${REPO}/ps-04-ai-platform`,
    overview:
      'One API for AI features, provider-agnostic. The default provider is a deterministic built-in mock that makes zero external calls, so chat, embeddings and RAG are reproducible offline and in CI. Real adapters for Anthropic, OpenAI, Google Gemini, Kimi (Moonshot AI) and Ollama (the open-source, local option) activate only when configured and requested by name; an unconfigured vendor falls back to the mock. Prompts are versioned with an active-version pointer, embeddings are cached, and RAG offers cosine search over ingested documents.',
    responsibilities: [
      'Chat completions with an append-only call log and idempotency',
      'Deterministic mock provider by default; falls back to it when a vendor is unconfigured',
      'Real adapters for Anthropic, OpenAI, Gemini, Kimi and Ollama (open-source, local)',
      'Embeddings from a local model, cached by (model, input hash); RAG cosine search',
      'Versioned prompt templates with an active-version pointer',
    ],
    api: [
      'POST /api/chat/completions · POST /api/embeddings',
      'GET/POST /api/prompts · PUT /api/prompts/:key/active',
      'POST /api/prompts/:key/render',
      'POST /api/rag/documents · POST /api/rag/search',
      'GET /api/completions',
    ],
    consumers: 'Any module that needs chat, embeddings, retrieval or prompts.',
  },
  {
    n: 'PS-05',
    slug: 'integration-hub',
    folder: 'ps-05-integration-hub',
    title: 'Integration Hub',
    purpose: 'Centralized third-party integrations — encrypted connections, a REST/GraphQL proxy, and verified webhooks.',
    status: 'Available',
    port: 4005,
    source: `${REPO}/ps-05-integration-hub`,
    overview:
      'The connection and translation layer to outside systems. Credentials are stored encrypted at rest (AES-256-GCM) and never returned; a config-as-code provider registry declares each vendor’s base URL, auth type and webhook signature scheme. A generic proxy issues REST or GraphQL calls through a connection, injecting the right auth header, and inbound webhooks are verified per provider before being recorded.',
    responsibilities: [
      'Connections with credentials encrypted at rest, redacted on read',
      'Provider registry (Google, Microsoft, Stripe, GitHub, Shopify, REST, GraphQL)',
      'Generic REST + GraphQL proxy with injected provider auth',
      'Inbound webhook signature verification per provider',
      'OAuth connect and sync jobs as documented seams',
    ],
    api: [
      'GET /api/providers',
      'GET/POST /api/connections · DELETE /api/connections/:id',
      'POST /api/connections/:id/proxy · /graphql',
      'POST /api/webhooks/:provider',
      'GET /api/webhook-events · GET /api/sync-jobs',
    ],
    consumers: 'Any module that talks to a third-party SaaS or external API.',
  },
];

export function getService(slug: string): PlatformService | undefined {
  return platform.find((s) => s.slug === slug);
}
