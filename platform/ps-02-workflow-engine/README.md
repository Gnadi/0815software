# PS-02 · Workflow Engine

Automation engine shared by every Business Module. Instead of each module
building its own cron jobs, event handlers and retry logic, they describe
workflows and let the engine run them.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto
only).

## What it is

- **Workflows** are versioned definitions — a set of steps and the legal
  transitions between them (`{initial, steps[], transitions{}, terminal[]}`).
- **Instances** are event-sourced: their current step and status are
  **folded from an append-only event stream at read time**, never stored,
  so nothing can drift.
- **Runs** are idempotent — a replay with the same `idempotency_key` and
  input returns the existing instance; a replay with a different input is a
  409 conflict.
- **Triggers** start workflows from events, schedules (interval-based, no
  catch-up backfill), inbound webhooks, or manually.
- **Outbound webhooks** are delivered with an HMAC `X-Signature`, an
  exponential backoff schedule, and dead-lettering after `MAX_ATTEMPTS`.
- A single `POST /api/tick` advances the scheduler and the delivery queue —
  drive it from cron, or call it in tests with an injected clock.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Tests   | Vitest + Supertest (injected clock + fetch) |

Runtime dependencies: `express`, `better-sqlite3`. Outbound HTTP uses the
built-in `fetch`.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-02-workflow-engine
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4002
```

```sh
curl -s localhost:4002/api/health
# admin session:
TOKEN=$(curl -s -X POST localhost:4002/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me"}' | jq -r .token)
curl -s localhost:4002/api/workflows -H "Authorization: Bearer $TOKEN"
# ingest an event (service token):
curl -s -X POST localhost:4002/api/events \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"type":"ticket.created","payload":{"ref":"TKT-1"}}'
```

Schedules advance when `POST /api/tick` is called (drive it from cron), or
set `TICK_INTERVAL_MS` to have the process advance the scheduler and delivery
queue on an internal timer. Production build: `npm run build && npm start`.

## API

Admin routes need a session cookie or `Authorization: Bearer <token>`
(from `POST /api/login`). Event ingestion and inbound hooks use the shared
`SERVICE_TOKEN` instead. Errors are `{ error, details? }`.

### Public / service-token

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | none | Liveness. |
| `POST /api/login` | none | `{username,password}` → admin token + cookie. |
| `POST /api/logout` | none | Clear the cookie. |
| `POST /api/events` | `X-Service-Token` | Ingest an event; matches `event` triggers, enqueues webhooks. Answers `{matched, instance_ids, enqueued, skipped, replayed}` — the fan-out is one transaction, and a trigger whose workflow is disabled is `skipped`, not an error. |
| `POST /api/hooks/:token` | token in path | Inbound webhook receiver. |

### Admin

| Method & path | Purpose |
| ------------- | ------- |
| `GET/POST /api/workflows`, `GET /api/workflows/:key` | List / create / fetch (current version). |
| `POST /api/workflows/:key/versions` | Append a new version. |
| `POST /api/workflows/:key/run` | Start an instance (idempotent). |
| `GET/POST /api/triggers`, `PATCH /api/triggers/:id` | Trigger admin. |
| `GET /api/instances`, `GET /api/instances/:id` | Folded state + allowed transitions. |
| `POST /api/instances/:id/advance` | Advance to a step (illegal → 422). |
| `GET/POST/DELETE /api/webhooks` | Outbound subscriptions. |
| `GET /api/deliveries`, `POST /api/deliveries/:id/retry` | Delivery queue. |
| `POST /api/tick` | Drive scheduler + dispatcher once. |

## Consumed by

Business Modules, over this API. The Workflow Engine depends on no Business
Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to verify
end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```

Covers idempotent runs (replay vs conflict), append-only folding + illegal
transitions, service-token gating on ingestion + inbound hooks, the
no-backfill scheduler, and webhook backoff → dead-letter → retry (with an
injected clock and a mocked `fetch`).

## API contract

The full endpoint + auth surface is documented in [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1). Request/response *shapes* are typed in
[`@0815software/platform-clients`](../clients) and pinned by `test/contract.test.ts`,
which boots this service and drives the real client over HTTP — so the client and
the service cannot drift apart unnoticed.
