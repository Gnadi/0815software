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

## Planned services

Nothing here is implemented yet — this catalog is documentation only. Each
folder is a placeholder describing the service's intended purpose and
scope.

| #     | Service          | Purpose                                   | Status  |
| ----- | ---------------- | ----------------------------------------- | ------- |
| PS-01 | Identity         | Shared authentication and authorization   | Planned |
| PS-02 | Workflow Engine  | Automation engine for all modules         | Planned |
| PS-03 | Notification Hub | Centralized notification delivery         | Planned |
| PS-04 | AI Platform      | Shared AI capabilities                    | Planned |
| PS-05 | Integration Hub  | Centralized third-party integrations      | Planned |

- [PS-01 · Identity](./ps-01-identity) — authentication, users, roles,
  permissions, OAuth, API keys, JWT, multi-tenancy.
- [PS-02 · Workflow Engine](./ps-02-workflow-engine) — workflows,
  triggers, events, scheduling, webhooks, retries.
- [PS-03 · Notification Hub](./ps-03-notification-hub) — email, SMS, push,
  chat channels, templates, queues.
- [PS-04 · AI Platform](./ps-04-ai-platform) — chat, embeddings, RAG,
  agents, prompt management, multi-provider LLM access.
- [PS-05 · Integration Hub](./ps-05-integration-hub) — OAuth connections
  and adapters for third-party SaaS and APIs.
