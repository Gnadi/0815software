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

All five services are implemented as **backend-only** packages: an Express 5
+ better-sqlite3 API with Vitest/Supertest tests and no client, matching the
module server idiom (Node built-in crypto only, no auth/ORM libraries). Each
is self-contained — install and run it independently.

| #     | Service          | Purpose                                   | API port | Status    |
| ----- | ---------------- | ----------------------------------------- | -------- | --------- |
| PS-01 | Identity         | Shared authentication and authorization   | 4001     | Available |
| PS-02 | Workflow Engine  | Automation engine for all modules         | 4002     | Available |
| PS-03 | Notification Hub | Centralized notification delivery         | 4003     | Available |
| PS-04 | AI Platform      | Shared AI capabilities                    | 4004     | Available |
| PS-05 | Integration Hub  | Centralized third-party integrations      | 4005     | Available |

- [PS-01 · Identity](./ps-01-identity) — authentication, users, roles,
  permissions, OAuth stub, API keys, HMAC/JWT-style sessions, multi-tenancy.
- [PS-02 · Workflow Engine](./ps-02-workflow-engine) — workflows,
  triggers, events, scheduling, webhooks, retries.
- [PS-03 · Notification Hub](./ps-03-notification-hub) — email, SMS, push,
  chat channels, templates, queues.
- [PS-04 · AI Platform](./ps-04-ai-platform) — chat, embeddings, RAG,
  prompt management; deterministic mock plus Anthropic, OpenAI, Gemini,
  Kimi and Ollama (open-source) adapters.
- [PS-05 · Integration Hub](./ps-05-integration-hub) — encrypted OAuth
  connections and REST/GraphQL adapters for third-party SaaS.

## Quickstart

Each service runs on its own. From any service folder:

```sh
cd platform/ps-01-identity   # …or ps-02 … ps-05
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on its port (see the table above)
npm test            # Vitest + Supertest
```

## Standalone in v1 (identity seam)

The services do not call each other at runtime yet. Each validates its own
admin/HMAC session, and every `.env.example` documents a commented-out
`IDENTITY_URL` marking where a real deployment would verify callers against
PS-01 (`POST /api/tokens/verify`). Because every service uses the same HMAC
token format as PS-01, that cutover is a configuration change, not a rewrite.
