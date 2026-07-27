# PS-11 · Customers

One answer to **"who is this customer?"** across every module in a stack.

Before this service, MOD-04 Invoice & Billing and MOD-13 Offers each owned a
`customers` table in their own database, and nothing reconciled them: a customer
who accepted a quote had to be retyped to be invoiced. MOD-10 CRM Lite had its
own `companies`, MOD-06 Procurement its own `suppliers`. A customer who licensed
three modules got three counterparty lists and expected one.

Those four now register their rows here (see
[Who consumes it](#who-consumes-it)); MOD-03 Inventory's supplier table is the
remaining one, and it will arrive the same way.

PS-11 holds the **party master record** — and, deliberately, nothing else. It is
not a CRM: no pipeline, no activities, no notes. Just the identity every module
needs to agree on.

See [`docs/CUSTOMER-MASTER-DATA.md`](../../docs/CUSTOMER-MASTER-DATA.md) for the
decision that led here, including the alternative that was rejected.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-ins only).

## What it is

- **Parties, by kind.** `customer` is someone you sell to, `supplier` someone
  you buy from, and matching **never crosses the two** — a company you both buy
  from and sell to is two relationships with two sets of terms, and letting a
  procurement import rewrite a customer's billing address would be a bug, not a
  feature. Each party holds name, contact person, email, VAT id, postal address
  and IBAN/BIC. VAT ids are stored normalized (upper-cased, whitespace
  stripped), emails lower-cased, so matching never depends on how someone typed
  it.
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
- **Merge** reconciles duplicates the service already holds — records that
  predate it, or that arrived with neither a VAT id nor an email to match on.
  References move onto the survivor, the survivor is enriched (never
  overwritten), and the loser's row is **kept as a redirect**: a module still
  holding the old id gets the surviving record, so nothing is deleted and no
  foreign key breaks.
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

# A supplier — a separate kind, never matched against a customer:
curl -s -X POST localhost:4011/api/parties/resolve \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"kind":"supplier","name":"Auer & Söhne GmbH","vat_id":"ATU87654321",
       "source":"mod-06-procurement-tracker","external_id":"3"}'

# Two records for one company? Merge 12 into 7; id 12 then redirects to 7:
curl -s -X POST localhost:4011/api/parties/12/merge \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"into":7}'

# The seller identity:
curl -s -X PUT localhost:4011/api/self \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"name":"Acme Corporation","vat_id":"ATU99999999",
       "address_lines":["Teststrasse 1","1010 Wien","Austria"]}'
```

## The seller identity

MOD-04 Invoice & Billing and MOD-13 Offers both print the seller's name, address
and VAT id, and both read them from their own `SELLER_*` environment. The `self`
party is where that one fact lives instead. With `CUSTOMERS_URL` configured, both
modules read it at boot and refresh it every five minutes, so **changing the
letterhead is a `PUT /api/self`, not a redeploy**. Precedence is deliberate and
one-directional:

| PS-11 `self` party | Result |
| --- | --- |
| set | it wins, field by field — a field left blank there falls back to the module's env, so a half-filled party cannot blank a letterhead |
| absent, or PS-11 unreachable | the module's `SELLER_*` env stands, unchanged |

A module never *writes* the seller here: one authority, set once by the operator.
For the same reason the seed deliberately creates **no** `self` party — seeding a
demo seller would silently replace a customer's configured letterhead the moment
PS-11 joined their stack.

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `GET /api/ready` | public | DB reachable + migrations current. |
| `GET /api/metrics` | public | Prometheus text, incl. `customers_parties_total` and `customers_suppliers_total`. |
| `POST /api/login` · `POST /api/logout` | public | Operator session. |
| `POST /api/parties/resolve` | service token / admin | Find-or-create. 201 created, 200 matched. |
| `GET /api/parties` | service token / admin | List; `q`, `kind`, `include_archived`, `limit`. |
| `POST /api/parties` | service token / admin | Create; honours `Idempotency-Key`. |
| `GET /api/parties/:id` | service token / admin | One party plus its references. |
| `PATCH /api/parties/:id` | service token / admin | Update the fields present in the body. |
| `POST /api/parties/:id/archive` | service token / admin | Retire a party. |
| `POST /api/parties/:id/erase` | service token / admin | GDPR erasure, in place. |
| `POST /api/parties/:id/merge` | service token / admin | Merge this party into `into`; the old id redirects. |
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

## Who consumes it

| Module | What it registers | Kind |
| --- | --- | --- |
| MOD-04 Invoice & Billing | customers it invoices, incl. those imported from an offer | `customer` |
| MOD-13 Offers | customers it quotes | `customer` |
| MOD-10 CRM Lite | companies in the pipeline | `customer` |
| MOD-06 Procurement Tracker | suppliers it buys from | `supplier` |

Each stores the master `party_id` on its own row, so the local table stays the
module's working record and PS-11 is the shared identity. MOD-01 Customer Portal
is deliberately **not** on this list: its `customers` are end users with logins,
which is an identity concern (PS-01's territory, deferred by readiness item C1)
rather than master data.

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
matching order, enrichment, idempotency, archival, erasure and the `self` party.
`test/merge.test.ts` covers the supplier kind (including that matching never
crosses kinds), merging with its redirects and refusals, and that migration 002's
table rebuild preserves every reference. `test/contract.test.ts` drives the real
`@0815software/platform-clients` `CustomersClient` against a real server over
HTTP.

## Backups

```sh
npm run backup      # DATABASE_PATH -> BACKUP_DIR/backup-<timestamp>.db
```

Online-consistent snapshot via better-sqlite3's backup API. **Restore** = stop
the service, replace `DATABASE_PATH` with a snapshot, start; pending migrations
apply on boot.
