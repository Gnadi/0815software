# Platform Services

Shared backend services that provide reusable capabilities to the
[Business Modules](../modules/README.md). A Platform Service does one
cross-cutting job well — identity, automation, notifications, AI,
integrations — and exposes it over an API so that every module consumes
the same implementation instead of rebuilding it.

**This directory contains Platform Services only.** It holds no
customer-facing applications; those live in [`../modules`](../modules).
The two catalogs are independent.

## Architecture rules

- A **Business Module** may depend on one or more Platform Services.
- A **Platform Service** never depends on a Business Module.
- Platform Services may depend on each other and on shared infrastructure.
- Modules talk to services over APIs — never by reaching into a service's
  internals or database.

```
Business Modules  →  Platform Services  →  Infrastructure
```

## Services

All services are implemented as **backend-only** packages: an Express 5
+ better-sqlite3 API with Vitest/Supertest tests, matching the module server
idiom (Node built-in crypto only, no auth/ORM libraries). Each is
self-contained — install and run it independently. Modules talk to them
through the shared [`clients`](./clients) package.

| #     | Service          | Purpose                                   | API port | Status    |
| ----- | ---------------- | ----------------------------------------- | -------- | --------- |
| PS-01 | Identity         | Shared authentication and authorization   | 4001     | Available |
| PS-02 | Workflow Engine  | Automation engine for all modules         | 4002     | Available |
| PS-03 | Notification Hub | Centralized notification delivery         | 4003     | Available |
| PS-04 | AI Platform      | Shared AI capabilities                    | 4004     | Available |
| PS-05 | Integration Hub  | Centralized third-party integrations      | 4005     | Available |
| PS-06 | File Storage     | Shared object/blob storage                | 4006     | Available |
| PS-07 | Audit Log        | Tamper-evident activity trail             | 4007     | Available |
| PS-08 | Payments         | Payment intents, refunds, reconciliation  | 4008     | Available |
| PS-09 | Search           | Cross-entity keyword & faceted search     | 4009     | Available |
| PS-10 | Number           | Gapless sequence numbers per scope        | 4010     | Available |

- [PS-01 · Identity](./ps-01-identity) — authentication, users, roles,
  permissions, OAuth (real OIDC flow + offline mock IdP), API keys,
  HMAC/JWT-style sessions, multi-tenancy.
- [PS-02 · Workflow Engine](./ps-02-workflow-engine) — workflows,
  triggers (event/schedule/webhook/manual), events, scheduling, webhooks, retries.
- [PS-03 · Notification Hub](./ps-03-notification-hub) — email, SMS, push,
  chat channels (Resend/Twilio/Slack/Teams/Discord adapters), templates, queues.
- [PS-04 · AI Platform](./ps-04-ai-platform) — chat, embeddings, RAG,
  prompt management, agents, image & speech; deterministic mock plus Anthropic,
  OpenAI, Gemini, Kimi and Ollama (open-source) adapters.
- [PS-05 · Integration Hub](./ps-05-integration-hub) — encrypted OAuth
  connections, REST/GraphQL proxy, inbound webhooks and sync jobs for third-party SaaS.
- [PS-06 · File Storage](./ps-06-file-storage) — tenant-scoped buckets,
  content-addressed objects, and HMAC-signed download URLs.
- [PS-07 · Audit Log](./ps-07-audit-log) — append-only, hash-chained
  activity trail with end-to-end integrity verification.
- [PS-08 · Payments](./ps-08-payments) — payment intents, refunds and a
  reconciled ledger; deterministic mock PSP plus an optional Stripe adapter.
- [PS-09 · Search](./ps-09-search) — cross-entity keyword & faceted search
  over SQLite FTS5 (lexical; complements PS-04's semantic RAG).
- [PS-10 · Number](./ps-10-number) — atomic, gapless sequence numbers per
  scope with formatting and period reset (invoice/order/offer numbering).

Modules consume these through the shared
[`@0815software/platform-clients`](./clients) package — one typed client per
service over the built-in `fetch`, with a `fetch` seam for offline tests.

## Quickstart

Each service runs on its own. From any service folder:

```sh
cd platform/ps-01-identity   # …or ps-02 … ps-07
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on its port (see the table above)
npm test            # Vitest + Supertest
```

## Identity seam

Each service validates its own admin/HMAC session and service token by
default (standalone mode). Setting `IDENTITY_URL` on any downstream service
activates the identity seam: a Bearer token that is **not** that service's
own admin token is then verified against PS-01's cross-service contract
(`POST /api/tokens/verify`), so a PS-01-issued end-user session is accepted
across services. Verification is delegated to PS-01 over HTTP — the services
do not need to share PS-01's token format, only its `tokens/verify` endpoint.
Leaving `IDENTITY_URL` unset keeps a service fully standalone.

Machine-to-machine calls (module → service) continue to use each service's
`SERVICE_TOKEN`; the seam is specifically for propagating end-user identity.
