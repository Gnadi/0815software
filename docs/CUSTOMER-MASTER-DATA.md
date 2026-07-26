# Customer Master Data: Where Does a Customer Live?

*Decision record for the shared-customer-data problem exposed by the
composability campaign, July 2026. Companion to
[`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md).*

> **Decided: Option B.** [PS-11 Customers](../platform/ps-11-customers) was
> built, and MOD-04 and MOD-13 consume it through a `CustomersClient`. The
> line-item hand-off Option A described was built on top of it, because the
> customer half being shared does not by itself move an offer's line items — see
> [What was built](#what-was-built) at the end. The analysis below is retained
> unedited as the audit trail; where it says "recommendation", the decision went
> one step further.

## The problem, as it actually appears in the code

`demo/scenario.mjs` narrates the flagship story: *a customer accepts a quote in
Offers, and Invoicing bills it.* The code does not do that. Around line 209 the
demo creates the customer **from scratch** in MOD-04 and retypes the line items
that MOD-13 already has:

```js
const customer = await invoicing.post('/api/customers', { name: 'Blaustern Café GmbH', … });
const draft    = await invoicing.post('/api/invoices', { customer_id: customer.body.id, lines: [ … ] });
```

There is no data path from an accepted offer to an invoice. The two modules each
own a `customers` table in their own SQLite file, and nothing reconciles them.

The same duplication shows up a second time, independently, in configuration:
**MOD-04 and MOD-13 both read `SELLER_NAME`, `SELLER_ADDRESS` and
`SELLER_VAT_ID`** from their own environment, because each prints a letterhead.
`deploy/provision.mjs` already has to paper over this, emitting one stack-scoped
`SELLER_*` group and wiring it into both modules — a generator working around a
modelling gap.

And it is not limited to those two modules. MOD-10 CRM Lite, MOD-01 Customer
Portal, MOD-06 Procurement Tracker and MOD-03 Inventory Management all carry a
customer-or-counterparty table of their own. A customer who licenses three
modules gets three customer lists and expects one.

## Why this is hard here specifically

The defining property of this repository is that **modules do not know about
each other**. Fourteen packages, zero cross-module imports, each installable and
runnable on its own with its own database, tests and licence. Anything that
makes MOD-04 depend on MOD-13 spends that property.

The platform's answer to every other cross-cutting concern has been a Platform
Service: identity, notifications, files, audit, payments, numbering, search, AI,
workflow, integrations. Modules depend on *services*, never on each other, and
always optionally.

## Option A — module-to-module import

MOD-13 exposes an accepted offer; MOD-04 ingests it and produces a draft
invoice. One endpoint on each side, a shared transfer shape, an `OFFERS_URL`
that may be unset.

**For it**

- Small and shippable now. No new service, no new migrations, no new package.
- Closes the visible gap: the demo narrative and the code finally agree, and the
  customer's "bill this quote" click becomes real.
- Degrades exactly like every other integration: unset `OFFERS_URL` means
  MOD-04 behaves as it does today.

**Against it**

- It is the **first cross-module dependency** in a codebase whose selling point
  is that there are none. Even done carefully — a versioned, neutral transfer
  shape rather than MOD-13's internals — MOD-04 now has an opinion about MOD-13.
- **It does not generalise.** The same duplication exists for MOD-10 → MOD-04,
  MOD-10 → MOD-13, MOD-01 → MOD-04, MOD-06 → MOD-03. Solving it pairwise is
  O(n²) endpoints, each with its own shape, its own auth and its own tests.
- It leaves the seller-identity duplication untouched.
- It creates no single answer to "what is this customer's address?" — it copies
  one module's answer into another and lets them drift from that moment on.

## Option B — PS-11 Customers, a platform service owning customer master data

A Platform Service holding customer/counterparty master data — identity,
addresses, VAT id, contacts, external references — consumed through a
`CustomerClient` in `@0815software/platform-clients` exactly like every other
platform concern. Modules read and write through it when `CUSTOMERS_URL` is set,
and keep their local table when it is not.

**For it**

- **Consistent with the architecture.** It is the same answer the platform gave
  to identity, numbering and audit. No module learns about another module.
- **Solves it once for all fourteen.** MOD-10 gets it for free; so do MOD-01,
  MOD-03 and MOD-06 when their turn comes. No O(n²).
- Gives the **seller identity a single home** too: the seller is just the
  customer's own party record, so `SELLER_NAME`/`SELLER_ADDRESS`/`SELLER_VAT_ID`
  stop being duplicated env vars and `provision.mjs` stops working around them.
- Makes GDPR erasure and the PII map materially better: one place holds customer
  PII instead of five module databases (see [`PII-MAP.md`](./PII-MAP.md)).
- Enables the deduplication and matching logic (by VAT id, by email) that every
  module would otherwise reinvent badly.

**Against it**

- A real new service: schema, migrations, OpenAPI, contract tests, a client,
  a boot guard, telemetry, backups, a slot in the registry and in every
  generated stack. Days, not hours.
- **A migration path is required** for the module-local customer tables that
  already exist and already hold data — probably a per-module import-on-first-run
  plus an `external_ref` on the PS-11 side, which is the fiddly part.
- One more service in the minimum footprint of any stack containing a
  customer-facing module.
- It does not, by itself, move the offer's *line items* — the transfer shape from
  Option A is still needed for the quote→invoice hand-off, just with the
  customer half resolved through PS-11.

## Recommendation (as written before the decision)

**Option B is the right destination; Option A is the right next commit.**

Ship Option A now, because the visible defect — a demo that narrates a data path
that does not exist — is worth closing this week, and because the hand-off of
*line items* is needed under either option. But build it so it is not a dead
end:

- put the transfer shape in **one file on each side** (`shared/transfer.ts`), so
  the wire format is a contract rather than an accident;
- make the shape **neutral** — a customer party plus line items plus currency and
  VAT — with none of MOD-13's internal ids, statuses or revision chain in it;
- keep the transport **optional and best-effort**, exactly like the platform
  hooks, so the standalone guarantee is untouched;
- make the import **idempotent on the offer reference**, so re-pointing it at a
  different source later cannot double-bill.

With that structure, swapping the transport for a PS-11 `CustomerClient` is a
change to one file per module and no change to the module UIs or to the invoice
domain logic.

The independent evidence for Option B is the **seller identity**: two modules
duplicate `SELLER_NAME`/`SELLER_ADDRESS`/`SELLER_VAT_ID` in their configuration
for reasons that have nothing to do with quotes or invoices. A pairwise import
cannot fix that; a party-master service fixes it as a side effect. When a third
module needs a customer record — MOD-10 CRM Lite is the obvious next one — that
is the signal to stop and build PS-11 rather than write a second bridge.

## Explicit non-goals

- **A shared customer database across customers.** The tenancy stance is
  unchanged: one stack per customer, so PS-11 would be that customer's
  customer list, not a global one (see [`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md)).
- **A generic ETL or sync framework between modules.** PS-05 Integration Hub
  exists for outside systems; this is about the platform's own data.
- **Making any module require the bridge.** MOD-04 with no `OFFERS_URL`, and
  later with no `CUSTOMERS_URL`, must keep passing its full existing suite
  unchanged. That is not a nicety; it is the property the catalogue is sold on.

## What was built

Option B, plus the line-item hand-off from Option A layered on top of it.

**[PS-11 Customers](../platform/ps-11-customers)** owns the party master record
— customers and, as a `self` party, the stack owner's own seller identity. Its
one interesting operation is `POST /api/parties/resolve`: find-or-create with a
fixed matching order (the caller's own reference, then VAT id, then email, then
create) that reports which rule fired and **enriches a matched record without
overwriting what it already knows**. `party_refs` is the migration path the
analysis called for: a module keeps its own row ids forever and registers them,
so two modules importing the same customer converge on one party. Erasure
anonymizes in place and keeps the id, so every module's foreign reference stays
valid.

**Both modules consume it optionally.** MOD-13 registers a customer with PS-11
when `CUSTOMERS_URL` is set; MOD-04 resolves an imported customer through it and
registers its own id too. With `CUSTOMERS_URL` unset, each module keeps its local
table and behaves exactly as before — the standalone guarantee is untouched, and
MOD-04's full pre-existing suite passes unchanged.

**The hand-off itself still needed a transfer shape**, exactly as the "Against
it" note under Option B predicted: PS-11 resolves *who* the customer is, but an
offer's line items, VAT breakdown and totals still have to cross. That shape
lives in `shared/transfer.ts`, copied into both modules, and is deliberately
neutral — no MOD-13 ids, statuses or revision chain. It is self-checking: every
line carries the net the source computed, the document carries the source's
totals, and an importer recomputes and **refuses the transfer if they disagree**,
so a rounding difference between two modules can never become a wrong invoice.
MOD-13 exposes `GET /api/offers/:number/transfer` behind the platform machine
token and only for *accepted* offers; MOD-04's
`POST /api/invoices/import-offer` produces a draft, idempotent on the offer
number and recording it on the invoice, so a retry cannot double-bill.

**The seller identity moved too.** MOD-04 and MOD-13 now read PS-11's `self`
party at boot and refresh it periodically, with their `SELLER_*` environment as
the fallback — per field, so a half-filled party cannot blank a letterhead. A
module never writes the seller back: one authority, set once with
`PUT /api/self`. Renaming the company is now one call instead of two `.env`
edits and a redeploy, which `demo/scenario.mjs` demonstrates live. For the same
reason PS-11's seed deliberately creates **no** `self` party: a demo seller would
silently replace a customer's configured letterhead the moment PS-11 joined their
stack.

**Suppliers are parties too.** `kind` gained `supplier` (migration 002), and
matching never crosses kinds — a company you both buy from and sell to is two
relationships with two sets of terms, and letting a procurement import rewrite a
customer's billing address would be a bug. MOD-06 Procurement Tracker registers
its suppliers; MOD-10 CRM Lite registers its companies as customers. Four modules
now share one party list.

**Duplicates can be reconciled.** A master-data service that cannot merge two
records it already holds is not finished: records predate PS-11, or arrive with
neither a VAT id nor an email to match on. `POST /api/parties/:id/merge` moves
references onto the survivor, enriches it without overwriting, and **keeps the
loser's row as a redirect** — so a module still holding the old id reads the
surviving record and no foreign key breaks.

**What this leaves open.** MOD-03 Inventory's supplier table has not been
migrated; it will arrive the same way MOD-06's did. MOD-01 Customer Portal is
deliberately out of scope: its `customers` are end users with logins, which is an
identity concern (PS-01's territory, deferred by readiness item C1) rather than
master data. And nothing yet *reports* likely duplicates — merging is available,
finding candidates is still the operator's eye.
