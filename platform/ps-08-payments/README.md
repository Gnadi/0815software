# PS-08 · Payments

Take and reconcile money for the 0815software platform. Modules create payment
intents, capture and refund them, and read a reconciled ledger through one API
— never touching card data or a PSP SDK themselves.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto only).

## What it is

- **Payment intents** — `{reference, amount_minor, currency}` with an
  idempotency key. Amounts are **integer minor units** (cents), matching the
  modules. Status is **folded from an append-only event stream** at read time
  (the PS-02 idiom), so it never drifts:
  `requires_payment → processing → succeeded → (partially_)refunded`, plus
  `failed` / `canceled`.
- **Providers** — a deterministic, offline **mock PSP** by default: `confirm`
  moves an intent to `processing`, and it settles to `succeeded` on
  `POST /api/tick` (simulating asynchronous settlement, zero external calls).
  An optional **Stripe** adapter (a single `fetch`, no SDK) activates when
  `STRIPE_SECRET_KEY` is set and confirms synchronously.
- **Refunds** — full or partial against a captured payment, validated against
  the refundable balance. The balance is claimed before the PSP is called, so
  two concurrent refunds can never exceed it, and an `idempotency_key` makes a
  retried request a no-op rather than a second refund.
- **Ledger** — append-only credits (on capture) and debits (on refund) per
  intent; `GET /api/ledger` is the reconciliation view.
- **Inbound webhooks** — `POST /api/webhooks/:provider`, HMAC-verified and
  recorded with a `signature_valid` verdict; a `payment.succeeded` /
  `payment.failed` event reconciles the matching intent (how a real PSP
  settles).
- **No card data** is ever stored — only the caller's reference and the PSP's
  own id.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Crypto  | Node built-in HMAC-SHA256 (webhooks)        |
| Tests   | Vitest + Supertest (offline, deterministic) |

Runtime dependencies: `express`, `better-sqlite3`. The Stripe adapter uses the
built-in `fetch`.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-08-payments
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4008
```

```sh
curl -s localhost:4008/api/health
# create + confirm an intent (service token), then settle it:
curl -s -X POST localhost:4008/api/intents \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"reference":"invoice:INV-1","amount_minor":12000,"currency":"EUR","confirm":true}'
curl -s -X POST localhost:4008/api/tick -H 'X-Service-Token: dev-service-token'
```

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `POST /api/login` · `POST /api/logout` | public | Admin session. |
| `POST /api/webhooks/:provider` | signature | Inbound PSP webhook (HMAC), reconciled to the intent. |
| `POST /api/intents` | caller | Create an intent (`confirm:true` to confirm at once). Idempotent. |
| `GET /api/intents` · `GET /api/intents/:id` | caller | List / read (folded status, events, ledger). |
| `POST /api/intents/:id/confirm` | caller | Confirm with the provider. |
| `POST /api/intents/:id/refund` | caller | Refund full or `{amount_minor}` partial; idempotent on `{idempotency_key}`. |
| `GET /api/ledger` | caller | The reconciliation ledger. |
| `POST /api/tick` | caller | Settle processing mock intents. |

A **caller** is the admin session or a module presenting `X-Service-Token`.

## Consumed by

Business Modules, over this API — Storefront checkout, Invoice & Billing
(pay-an-invoice + reconciliation), Subsidies disbursements, Offers deposits.
Payments depends on no Business Module. Set `IDENTITY_URL` (see
[`.env.example`](./.env.example)) to verify end-user callers against PS-01's
`POST /api/tokens/verify`; unset, the service runs standalone on its own
admin/service-token.

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
