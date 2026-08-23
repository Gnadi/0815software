// Single source of truth for the Platform Services catalogue: the grid on
// platform.astro and the per-service detail pages (platform/[slug].astro).
// Platform Services are shared backend capabilities consumed by the
// Business Modules over APIs — see src/data/modules.ts for the modules.

import { registryServices } from '../../modules/registry.ts';

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
  {
    n: 'PS-06',
    slug: 'file-storage',
    folder: 'ps-06-file-storage',
    title: 'File Storage',
    purpose: 'Shared blob store — buckets, content-addressed objects, and short-lived signed download links.',
    status: 'Available',
    port: 4006,
    source: `${REPO}/ps-06-file-storage`,
    overview:
      'One place for the files modules produce — invoice PDFs, product images, report exports, uploaded documents — instead of each writing to its own disk and reinventing checksums, metadata and links. Objects are addressed by bucket and key, and every one carries its size and SHA-256 alongside a content type and free-form metadata. A module can mint a short-lived HMAC-signed URL and hand it straight to a browser: it serves the bytes without a session, always as an attachment under a sandbox CSP, and a tampered or expired link is refused. Bytes live in SQLite as BLOBs by default, so there is nothing else to run.',
    responsibilities: [
      'Buckets and objects addressed by bucket + key, with free-form metadata',
      'Content addressing — SHA-256 and size recorded for every object',
      'Short-lived HMAC-signed download URLs that need no session',
      'Downloads always served as attachments, so stored bytes cannot execute',
      'Object bytes in SQLite by default; an S3-compatible backend behind the same API',
    ],
    api: [
      'PUT /api/objects/:bucket/:key · GET /api/objects/:bucket/:key',
      'GET /api/objects/:bucket/:key/meta',
      'POST /api/objects/:bucket/:key/sign',
      'GET /api/download?bucket=&key=&expires=&sig=',
      'GET/POST /api/buckets · DELETE /api/objects/:bucket/:key',
    ],
    consumers: 'Any module that produces or stores a file.',
  },
  {
    n: 'PS-07',
    slug: 'audit-log',
    folder: 'ps-07-audit-log',
    title: 'Audit Log',
    purpose: 'Tamper-evident, append-only activity trail — who did what to which resource, verifiable end to end.',
    status: 'Available',
    port: 4007,
    source: `${REPO}/ps-07-audit-log`,
    overview:
      'Every module records its activity here instead of scattering audit rows through its own database. Events are append-only, and each one’s SHA-256 hash covers both its own content and the previous event’s hash, so the log is a chain: rewriting, removing or reordering any past event breaks every hash after it. The chain head is recorded with each append, which also catches events deleted from the end — the edit a hash chain alone cannot see. GET /api/verify recomputes the whole chain and reports how it broke. Retention pruning re-anchors the chain rather than severing it.',
    responsibilities: [
      'Append-only events: actor, org, action, resource, before/after, metadata',
      'SHA-256 hash chain over content and predecessor',
      'Integrity verification that detects rewrites, deletions, reordering and truncation',
      'Idempotent recording, so a retried emit is not a second entry',
      'Retention pruning that re-anchors the chain instead of breaking it',
    ],
    api: [
      'POST /api/events · GET /api/events',
      'GET /api/verify',
      'GET /api/export',
      'GET /api/health · GET /api/ready · GET /api/metrics',
    ],
    consumers: 'Every module that needs a defensible record of what happened.',
  },
  {
    n: 'PS-08',
    slug: 'payments',
    folder: 'ps-08-payments',
    title: 'Payments',
    purpose: 'Take and reconcile money — payment intents, refunds, an append-only ledger and verified PSP webhooks.',
    status: 'Available',
    port: 4008,
    source: `${REPO}/ps-08-payments`,
    overview:
      'Modules create payment intents, capture and refund them, and read a reconciled ledger through one API, never touching card data or a PSP SDK. Amounts are integer minor units throughout — money is never a float. Status is folded from an append-only event stream at read time, so it cannot drift. The default provider is a deterministic offline mock that settles on a tick; an optional Stripe adapter (one fetch, no SDK) activates when a key is configured. A refund claims the refundable balance before the PSP is called, so two concurrent refunds can never exceed it, and idempotency keys make a retried request a no-op rather than a second payment.',
    responsibilities: [
      'Payment intents in integer minor units, idempotent on creation',
      'Status folded from an append-only event stream, never stored',
      'Full and partial refunds validated against a pre-claimed balance',
      'Append-only ledger of credits and debits for reconciliation',
      'HMAC-verified inbound webhooks with a replay window; mock PSP by default, Stripe optional',
    ],
    api: [
      'POST /api/intents · GET /api/intents',
      'POST /api/intents/:id/confirm · POST /api/intents/:id/refund',
      'GET /api/ledger',
      'POST /api/webhooks/:provider',
      'POST /api/tick',
    ],
    consumers: 'Any module that charges or refunds a customer.',
  },
  {
    n: 'PS-09',
    slug: 'search',
    folder: 'ps-09-search',
    title: 'Search',
    purpose: 'Cross-entity keyword and faceted search over every module’s records, on SQLite FTS5.',
    status: 'Available',
    port: 4009,
    source: `${REPO}/ps-09-search`,
    overview:
      'Modules index their records — products, documents, contacts, tickets — and query them with filters through one API instead of each hand-rolling LIKE queries. Full-text search is backed by SQLite FTS5, bundled with the database driver, so there is no external search engine to operate. Collections namespace documents by type and a tenant scopes them. Arbitrary key/value facets filter the result set and come back as counts over the matches. Re-indexing a document replaces the previous one. This is lexical search; it complements PS-04’s semantic RAG rather than duplicating it.',
    responsibilities: [
      'Full-text search on SQLite FTS5, BM25-ranked, with prefix matching',
      'Collections and tenant scoping for indexed documents',
      'Facet filtering and facet counts over the matching set',
      'Upsert semantics — re-indexing replaces, deletion de-indexes',
      'Deterministic and offline; no external search engine',
    ],
    api: [
      'POST /api/index',
      'DELETE /api/index/:collection/:id',
      'GET /api/search?q=&collection=&facet.<key>=',
      'GET /api/health · GET /api/ready · GET /api/metrics',
    ],
    consumers: 'Any module whose users need to find records across the stack.',
  },
  {
    n: 'PS-10',
    slug: 'number',
    folder: 'ps-10-number',
    title: 'Number',
    purpose: 'One authority for gapless sequence numbers — invoice numbers, order refs, offer numbers, PO refs.',
    status: 'Available',
    port: 4010,
    source: `${REPO}/ps-10-number`,
    overview:
      'Gapless, per-period invoice numbering is a legal requirement in the DACH market, and it is a race condition waiting to happen. Modules ask this service for the next number in a scope instead of each re-implementing a careful counter. Allocation is a single atomic transaction, so concurrent callers never receive a duplicate and never skip a value. A scope’s format renders the number from tokens — {seq}, zero-padded {seq:0000}, {YYYY}, {YY}, {MM}, {DD} — and its period restarts the counter each year, month or day, or never.',
    responsibilities: [
      'Independent counters per scope (invoice, order, offer, purchase order…)',
      'Atomic allocation — no duplicates and no gaps under concurrency',
      'Token-based formatting, e.g. INV-{YYYY}-{seq:0000} → INV-2026-0001',
      'Period reset by year, month or day; gapless within the period',
      'A sensible default format auto-created for an unknown scope',
    ],
    api: [
      'POST /api/next',
      'GET/POST /api/sequences · GET /api/sequences/:scope',
      'GET /api/health · GET /api/ready · GET /api/metrics',
    ],
    consumers: 'MOD-04 Invoice & Billing, MOD-13 Offers, MOD-06 Procurement, MOD-07 Storefront.',
  },
  {
    n: 'PS-11',
    slug: 'customers',
    folder: 'ps-11-customers',
    title: 'Customers',
    purpose: 'The party master record — one answer to “who is this customer?” across every module in a stack.',
    status: 'Available',
    port: 4011,
    source: `${REPO}/ps-11-customers`,
    overview:
      'A customer who licensed three modules used to get three counterparty lists and expected one: Invoice & Billing and Offers each owned a customers table, CRM Lite its own companies, Procurement its own suppliers, and nothing reconciled them. PS-11 holds the party master record and, deliberately, nothing else — no pipeline, no activities, no notes. Parties are kinds: a customer is someone you sell to, a supplier someone you buy from, and matching never crosses the two. Modules resolve a party by external reference or by matching attributes, and merges keep the losing record resolvable so old links never break.',
    responsibilities: [
      'Party master records by kind, with customers and suppliers kept apart',
      'Resolve-or-create by external reference or matching attributes',
      'External references per source module, so each keeps its own ids',
      'Merge with the losing record left resolvable; archive and GDPR erase',
      'The one counterparty list a multi-module stack agrees on',
    ],
    api: [
      'POST /api/parties/resolve',
      'GET/POST /api/parties · GET/PATCH /api/parties/:id',
      'POST /api/parties/:id/merge · /archive · /erase',
      'GET/POST /api/parties/:id/refs',
    ],
    consumers: 'MOD-04 Invoice & Billing, MOD-13 Offers, MOD-10 CRM Lite, MOD-06 Procurement.',
  },
  {
    n: 'PS-12',
    slug: 'banking',
    folder: 'ps-12-banking',
    title: 'Banking',
    purpose: 'EBICS 3.0 bank transport — key custody, the key exchange, and signed ISO 20022 uploads over the customer’s own bank connection.',
    status: 'Available',
    port: 4012,
    source: `${REPO}/ps-12-banking`,
    overview:
      'MOD-04 already produces a valid pain.001 SEPA credit transfer per payment run; today a human downloads it and uploads it in online banking. EBICS is the protocol that removes the manual step, and this is a Platform Service rather than a module feature for one reason above the others: an EBICS subscriber holds RSA private keys that are sufficient to move money, and those keys belong in exactly one place, guarded once. Private keys are AES-256-GCM ciphertext at rest, are never returned by any endpoint, and are reached through one function that takes a purpose rather than a key id. The protocol layer is Node built-ins only — the exclusive XML canonicaliser and the XML-DSig signature are implemented here rather than taken as dependencies. It speaks twenty of the twenty-one order types the EBICS 3.0 schema set defines, and it reads back what the bank sends: account statements become bookings a module can search, so an incoming payment finds its invoice. Every message it builds is validated against the published schemas on every test run — the EBICS ones, the ISO 20022 statement schemas, and Austria’s stricter subset — and the order-type tables are transcribed rather than guessed. That discipline is what found each of the defects this service has had, including two that no amount of testing against itself would have shown. Nothing in it has yet spoken to a real bank.',
    responsibilities: [
      'Subscriber key custody: A005/A006 signing, X002 authentication, E002 encryption',
      'The EBICS key exchange — INI, HIA, HPB — and a printable INI letter',
      'A connection goes live only when a human confirms the bank’s key digests',
      'Signed BTU uploads of any ISO 20022 file, with segmentation and receipts',
      'A payment file is submitted at most once, and per-connection ceilings hold',
      'Ask the bank what it has enabled for you — accounts, order types, signature class',
      'Fetch any file the bank offers, on a schedule you choose per connection',
      'Account statements read into bookings a module can search by reference, amount or date',
      'The bank’s own log of what it did with each order, folded into the orders',
      'The distributed-signature queue: see what awaits a second signature, co-sign it, or cancel it',
      'Renew the subscriber keys over the wire — no second paper letter',
      'Lock a compromised subscriber at the bank yourself, without a phone call',
      'German and Austrian order types, Verification of Payee, and the Austrian payment formats',
    ],
    api: [
      'GET /api/banks · GET/POST /api/connections',
      'POST /api/connections/:key/keys · /ini · /hia · /hpb',
      'GET /api/connections/:key/ini-letter.pdf',
      'POST /api/connections/:key/verify-bank-keys · /suspend · /resume · /lock',
      'GET /api/connections/:key/veu · POST …/veu/detail · /transactions · /sign · /cancel',
      'POST /api/orders (?validate=1) · GET /api/orders[/:id]',
      'GET /api/downloads[/:id][/content] · POST /api/tick',
    ],
    consumers: 'MOD-04 Invoice & Billing; any module that can produce an ISO 20022 file.',
  },
];

export function getService(slug: string): PlatformService | undefined {
  return platform.find((s) => s.slug === slug);
}

/**
 * Drift guard, at build time.
 *
 * This catalogue is hand-written copy, so nothing structurally tied it to the
 * services that actually exist — and it silently fell six behind: the site
 * advertised five Platform Services while the repository shipped eleven. The
 * registry is the machine-readable source of truth (`modules/registry.json`,
 * which `deploy/provision.mjs` and the demo hubs also read), so a service that
 * exists without a catalogue entry now fails `npm run build` rather than
 * quietly going unlisted. Ports and folders are checked against it too, so a
 * renamed directory or a moved port cannot leave a dead link behind.
 */
(function checkAgainstRegistry(): void {
  const bySlug = new Map(platform.map((s) => [s.folder, s]));
  const missing: string[] = [];
  for (const entry of registryServices) {
    const service = bySlug.get(entry.id);
    if (!service) {
      missing.push(`${entry.n} (${entry.id}) has no entry in src/data/platform.ts`);
      continue;
    }
    if (service.n !== entry.n) missing.push(`${entry.id}: catalogue says ${service.n}, registry says ${entry.n}`);
    if (service.port !== entry.defaultPort) {
      missing.push(`${entry.id}: catalogue port ${service.port}, registry port ${entry.defaultPort}`);
    }
  }
  for (const service of platform) {
    if (!registryServices.some((e) => e.id === service.folder)) {
      missing.push(`${service.n}: catalogue lists ${service.folder}, which is not in the registry`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Platform Services catalogue is out of sync with modules/registry.json:\n  ${missing.join('\n  ')}`);
  }
})();
