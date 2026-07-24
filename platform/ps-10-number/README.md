# PS-10 · Number

One authority for **gapless sequence numbers** across the platform — invoice
numbers, order refs, offer numbers, PO refs. Modules ask for the next number in
a scope instead of each re-implementing a race-careful, per-year counter (a
legal requirement for invoice numbering in DACH).

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto only).

## What it is

- **Scopes** each own an independent counter (`invoice`, `order`, …).
- **Atomic and gapless** — `POST /api/next` increments in a single
  transaction; concurrent callers never get a duplicate or skip a value.
- **Formatting** — a scope's `format` renders the number with tokens:
  `{seq}` / `{seq:0000}` (zero-padded), `{YYYY}`, `{YY}`, `{MM}`, `{DD}`.
  e.g. `INV-{YYYY}-{seq:0000}` → `INV-2026-0001`.
- **Period reset** — `period` of `year` / `month` / `day` restarts the counter
  at 1 each period (gapless *within* the period); `none` never resets.
- Auto-creates a sensible default (`{YYYY}-{seq:0000}`) for an unknown scope.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (atomic UPSERT + RETURNING)  |
| Tests   | Vitest + Supertest (injected clock)         |

Runtime dependencies: `express`, `better-sqlite3`. Nothing else.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-10-number
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4010
```

```sh
curl -s localhost:4010/api/health
# configure a scope, then allocate numbers (service token):
curl -s -X POST localhost:4010/api/sequences \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"scope":"invoice","format":"INV-{YYYY}-{seq:0000}","period":"year"}'
curl -s -X POST localhost:4010/api/next \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"scope":"invoice"}'    # → {"scope":"invoice","value":1,"formatted":"INV-2026-0001",...}
```

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `POST /api/login` · `POST /api/logout` | public | Admin session. |
| `POST /api/next` | caller | `{scope}` → the next gapless number. |
| `POST /api/sequences` | caller | Configure `{scope, format, period?}`. |
| `GET /api/sequences` · `GET /api/sequences/:scope` | caller | List / inspect (peek without incrementing). |

A **caller** is the admin session or a module presenting `X-Service-Token`.

## Consumed by

Business Modules, over this API — Invoice & Billing, Storefront, Offers and
Procurement source their document numbers here (opt-in). Number depends on no
Business Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to
verify end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```

## API contract

The full endpoint + auth surface is documented in [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1). Request/response *shapes* are typed in
[`@0815software/platform-clients`](../clients) and pinned by `test/contract.test.ts`,
which boots this service and drives the real client over HTTP — so the client and
the service cannot drift apart unnoticed.
