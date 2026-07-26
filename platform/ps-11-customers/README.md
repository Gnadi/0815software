# PS-11 · Customers

One answer to **"who is this customer?"** across every module in a stack.

Before this service, MOD-04 Invoice & Billing and MOD-13 Offers each owned a
`customers` table in their own database, and nothing reconciled them: a customer
who accepted a quote had to be retyped to be invoiced. MOD-10 CRM Lite, MOD-01
Customer Portal, MOD-03 Inventory Management and MOD-06 Procurement Tracker each
keep a counterparty table of their own too. A customer who licenses three
modules got three customer lists and expected one.

PS-11 holds the **party master record** — and, deliberately, nothing else. It is
not a CRM: no pipeline, no activities, no notes. Just the identity every module
needs to agree on.

See [`docs/CUSTOMER-MASTER-DATA.md`](../../docs/CUSTOMER-MASTER-DATA.md) for the
decision that led here, including the alternative that was rejected.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-ins only).

## What it is

- **Parties.** Name, contact person, email, VAT id, postal address, IBAN/BIC.
  VAT ids are stored normalized (upper-cased, whitespace stripped), emails
  lower-cased, so matching never depends on how someone typed it.
- **`resolve` — find-or-create, and the only call most modules make.** It
  matches in a fixed order and tells you which rule fired:
  1. the caller's own reference (`source` + `external_id`),
  2. VAT id,
  3. email,
  4. otherwise it creates the party.
- **Enrich, never clobber.** A resolve that matches fills in fields the master
  record is missing and leaves everything it already knows alone. A module
  importing a thin copy of a customer therefore cannot degrade the record;
  changing a known value takes an explicit `PATCH`.
- **References** are the migration path for module-local tables: a module keeps
  its own row ids forever and registers them here, so importing the same row
  twice converges on one party instead of duplicating it.
- **The `self` party** is the stack owner's own identity — the seller whose name,
  address and VAT id modules print on invoices and offers. Exactly one exists per
  stack (a partial unique index enforces it), which is what gives the duplicated
  `SELLER_NAME` / `SELLER_ADDRESS` / `SELLER_VAT_ID` configuration one home.
- **GDPR erasure** anonymizes in place and archives, keeping the row, its id and
  its references so every module's foreign reference stays valid — the same
  stance PS-01 takes for users.

Archived parties are excluded from lists and are never matched by `resolve`, so
retiring a customer cannot silently resurrect them on the next import.

## Tenancy

One stack per customer, so this database *is* that customer's customer list —
there is no cross-customer party table. See
[`docs/DEPLOYMENT-MODEL.md`](../../docs/DEPLOYMENT-MODEL.md).

## Stack

| Layer   | Choice                                     |
| ------- | ------------------------------------------ |
| API     | Node 20+ · Express 5 · TypeScript (strict) |
| Storage | better-sqlite3, migrations in `server/db.ts` |
| Tests   | Vitest + Supertest (offline, injected clock) |

Runtime dependencies: `express`, `better-sqlite3`. Nothing else.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-11-customers
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4011
```

```sh
curl -s localhost:4011/api/health

# Resolve a customer, registering MOD-13's own id for it:
curl -s -X POST localhost:4011/api/parties/resolve \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"name":"Blaustern Café GmbH","vat_id":"ATU12345678",
       "source":"mod-13-offers","external_id":"7"}'
# → {"party":{...},"matched_on":"created","created":true}

# MOD-04 resolving the same customer converges on the same party:
curl -s -X POST localhost:4011/api/parties/resolve \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"name":"Blaustern Cafe","vat_id":"atu 1234 5678",
       "source":"mod-04-invoice-billing","external_id":"31"}'
# → {"party":{...same id...},"matched_on":"vat_id","created":false}

# The seller identity:
curl -s -X PUT localhost:4011/api/self \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"name":"Acme Corporation","vat_id":"ATU99999999",
       "address_lines":["Teststrasse 1","1010 Wien","Austria"]}'
```

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `GET /api/ready` | public | DB reachable + migrations current. |
| `GET /api/metrics` | public | Prometheus text, incl. `customers_parties_total`. |
| `POST /api/login` · `POST /api/logout` | public | Operator session. |
| `POST /api/parties/resolve` | service token / admin | Find-or-create. 201 created, 200 matched. |
| `GET /api/parties` | service token / admin | List; `q`, `kind`, `include_archived`, `limit`. |
| `POST /api/parties` | service token / admin | Create; honours `Idempotency-Key`. |
| `GET /api/parties/:id` | service token / admin | One party plus its references. |
| `PATCH /api/parties/:id` | service token / admin | Update the fields present in the body. |
| `POST /api/parties/:id/archive` | service token / admin | Retire a party. |
| `POST /api/parties/:id/erase` | service token / admin | GDPR erasure, in place. |
| `GET /api/parties/:id/refs` · `POST .../refs` | service token / admin | Consumer references. |
| `GET /api/self` · `PUT /api/self` | service token / admin | The stack owner's own party. |

Full endpoint + auth surface: [`openapi.yaml`](./openapi.yaml).

`PUT /api/self` is a put, not a patch: fields absent from the body are cleared.

## Auth

Same posture as every other Platform Service: a machine caller presents
`X-Service-Token`, an operator uses the local admin session, and when
`IDENTITY_URL` is set a PS-01 session holding `platform:admin` is accepted
through the identity seam. Health, readiness and metrics are public; everything
else requires a caller.

Under `NODE_ENV=production` the boot guard refuses to start while
`SESSION_SECRET`, `ADMIN_PASSWORD` or `SERVICE_TOKEN` still carries a known dev
default.

## Consuming it

```ts
import { CustomersClient } from '@0815software/platform-clients';

const customers = new CustomersClient({ baseUrl: process.env.CUSTOMERS_URL!, serviceToken });

const { party, matched_on } = await customers.resolve({
  name: 'Blaustern Café GmbH',
  vat_id: 'ATU12345678',
  source: 'mod-04-invoice-billing',
  external_id: String(localCustomerId),
});
```

Integration is opt-in and best-effort, like every other platform hook: a module
with no `CUSTOMERS_URL` keeps its local customer table and behaves exactly as it
did before this service existed.

## Tests

```sh
npm test
```

Fully offline. `test/api.test.ts` covers validation and normalization, the
matching order, enrichment, idempotency, archival, erasure and the `self` party;
`test/contract.test.ts` drives the real `@0815software/platform-clients`
`CustomersClient` against a real server over HTTP.

## Backups

```sh
npm run backup      # DATABASE_PATH -> BACKUP_DIR/backup-<timestamp>.db
```

Online-consistent snapshot via better-sqlite3's backup API. **Restore** = stop
the service, replace `DATABASE_PATH` with a snapshot, start; pending migrations
apply on boot.
