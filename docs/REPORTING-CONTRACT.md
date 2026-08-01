# The Reporting Contract: `report_*` Views

*How a module makes itself reportable without making its schema public.
Decided July 2026, alongside the correction of MOD-08's provisioning
constraint.*

## The stance

**A module that wants to be reported on publishes a set of `report_*` VIEWS in
its own database. Those views are its contract. Its tables are private.**

Read "views" literally. Only a SQLite object of type `view` whose name starts
with `report_` is public. A **table** called `report_secrets` is not published,
is not listed, and cannot be queried in restricted mode — the prefix is the
convention a module follows when publishing, and the source's own catalog
(`sqlite_master`) is what authorises an object. A module names its own objects,
so letting the name grant access would put the boundary in the wrong place.

Everything else follows from that one sentence:

- A consumer — today, MOD-08 Reporting Suite — reads the views. It never reads
  the tables, and it never needs to know they exist.
- The owning module keeps the right to refactor its tables freely. Split a
  table, rename a column, add a migration: as long as the views still produce
  the same columns, no consumer notices and nothing breaks.
- The views are also where the module's *business rules* live for reporting
  purposes — which rows count, how money is rounded — so a report cannot
  quietly disagree with the module's own screens.

This is a **convention plus a flag**, not a service. It costs no container, no
network hop, no per-customer runtime and no new failure mode. It is also the
same contract a hypothetical PS-12 read-model service would have to carry if
one is ever built, so adopting it now is not work that gets thrown away — see
[`PLATFORM-SERVICE-OPPORTUNITIES.md`](./PLATFORM-SERVICE-OPPORTUNITIES.md).

## How a module publishes a set

In the module's own `server/db.ts`, run on every open:

```ts
db.exec(`DROP VIEW IF EXISTS report_invoices;`);
db.exec(`
  CREATE VIEW report_invoices AS
  SELECT
    i.number     AS invoice_number,
    c.name       AS customer_name,
    ...
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.status <> 'draft';
`);
```

**Drop and recreate, not `CREATE VIEW IF NOT EXISTS`.** A view holds no data,
so rebuilding one costs nothing and loses nothing — whereas `IF NOT EXISTS` is
inert on any database that already ran it, which would mean a column added to
the contract reached fresh test databases and never reached a deployed stack.
Tests would pass while the contract stayed broken in production. The rebuild is
what makes "adding a column is a compatible change" (below) true *on upgrade*
rather than only on a fresh install.

Drop in reverse dependency order and create in dependency order when one view
reads another — MOD-04's `report_receivables_aging` reads `report_invoices`.

**No table changes, no data changes, no triggers.** The rebuild applies on the
next boot, on a fresh database and an existing one alike, and running it twice
is a no-op.

MOD-04 Invoice & Billing is the reference implementation
(`modules/mod-04-invoice-billing/server/db.ts`), publishing four views:

| View | One row per | Key | Cancellation fields |
| ---- | ----------- | --- | ------------------- |
| `report_invoices` | non-draft invoice — header, customer, net/VAT/gross, paid, outstanding, days overdue | `invoice_number` | `status`, `is_cancelled`, `cancelled_at`, `cancellation_reason` |
| `report_invoice_lines` | invoice line, with the line net | `invoice_number` + `line_position` | `status`, `is_cancelled` |
| `report_payments` | payment, joined to invoice and customer | `payment_id` | `invoice_status`, `invoice_is_cancelled` |
| `report_receivables_aging` | customer with an open balance, in the conventional buckets | `customer_id` | n/a — cancelled invoices are excluded |

It is deliberately the *only* module with a set so far. One reference
implementation, then a decision about rollout.

## The rules a set must follow

**Naming.** Every published object is a view whose name starts with `report_`.
Nothing else in the database may use that prefix. Column names are
`snake_case`, spelled out, and mean the same thing in every view of the set
(`invoice_number` is `invoice_number` everywhere).

**Stability.** The column names are the contract:

- Adding a column is a compatible change. Do it freely.
- Adding a view is a compatible change.
- Renaming, removing or changing the meaning or units of a column is a
  **breaking change**. It needs a new column alongside the old one, or a
  deliberate version bump agreed with the consumers.
- A test in the owning module should assert the published column list, so a
  breaking change cannot happen by accident. MOD-04's
  `test/report-views.test.ts` does exactly this.

**Only business facts.** Nothing provisional is published. In MOD-04 that means
**drafts never appear**: a draft invoice has no number and no issue date, and
is not a fact about the business yet.

**Cancellation is marked on every row-level view, not just the header.**
Records that were cancelled or voided *are* published — omitting them would
silently lose numbers that were really issued — but every published row must
carry enough context to be filtered out. A detail view that inherits its
parent's cancellation state is the difference between
`SELECT SUM(line_net_cents) FROM report_invoice_lines` being a number you can
use and one that silently includes cancelled revenue. In MOD-04:
`report_invoices` and `report_invoice_lines` carry `status` / `is_cancelled`;
`report_payments` carries `invoice_status` / `invoice_is_cancelled`,
disambiguated because that view already holds payment-level fields. A payment
against a cancelled invoice stays published — it is money that moved and
probably needs refunding.

**Money is computed the way the module computes it.** A view must not re-derive
rounding in SQL that differs from the application's. If the module rounds per
line, the view rounds per line. MOD-04's views mirror `shared/money.ts` exactly
— net rounded per line, VAT rounded once per rate on that rate's tax base — and
a test asserts a view's total equals `computeTotals()` for the same invoice.
This is the rule that stops a receivables report and an invoice PDF from
disagreeing about what a customer owes.

**Keys, not internals.** Internal ids stay out of the contract unless they are
genuinely the useful key. `invoice_number` is published because it is the
immutable business key a human can cite; `customer_id` is published because a
customer has no other stable key (a name is not unique, a VAT id is nullable);
`invoices.id` is not published at all.

**Denormalised on purpose.** A view carries the customer's name next to the
invoice so a consumer does not have to join across the contract. The views are
a read model, not a normalised schema.

## How MOD-08 is pointed at a set

MOD-08 reads whatever SQLite file `SOURCE_DB_PATH` names, **read-only**
(`{ readonly: true, fileMustExist: true }`). Nothing about that changed:

```sh
SOURCE_DB_PATH=/source/data.db npm start
```

In a generated stack, `deploy/provision.mjs --source-db <module-id>` mounts the
named module's volume at `/source` read-only and makes MOD-08 wait for that
module to be healthy — a fresh volume has no database file yet. The flag is
**optional**: without it MOD-08 is provisioned standalone against its own
generated demo source, which is the module's own documented default. See
[`PROVISIONING.md`](./PROVISIONING.md).

**Restricted mode is switched on for you.** When the named source module
declares `publishesReportViews` in `modules/registry.json`, the generator emits
`SOURCE_VIEWS_ONLY=true` alongside `SOURCE_DB_PATH`. Pointing MOD-08 at MOD-04
therefore restricts it to MOD-04's contract by default, with no hand edit of
`.env`. A source that publishes no views gets no flag — implying a contract
that does not exist would restrict MOD-08 to an empty surface.

### `SOURCE_VIEWS_ONLY`

Off by default at the module level. Set it to `true` and MOD-08 is held to the
published surface:

- `GET /api/source` lists **only** the source's published views, so the query
  editor never offers a private table — nor a private table named `report_*`;
- a report's SQL is refused — at save time *and* at run time — if it reads
  anything outside that set, with a message that names the offending object.

**What "reads" means.** The restriction is on the objects a query reads, found
by scanning the token stream for every `FROM` and `JOIN` operand at every
nesting depth. None of these get round it:

- an alias — `FROM customers AS report_c` reads `customers`;
- a CTE — `WITH report_x AS (SELECT * FROM customers)` reads `customers` in the
  CTE body, which is scanned like any other `FROM`;
- a subquery, at any depth;
- a comma-join, including one after a join constraint (`FROM a JOIN b ON …, c`);
- a **parenthesised table list or join clause** — `FROM (customers)`,
  `FROM (customers, report_invoices)`, `FROM (customers JOIN … )`. SQLite's
  grammar allows these and they are not subqueries;
- a quoted, bracketed or backticked identifier, a schema qualifier, or
  different casing;
- a table-valued function such as `pragma_table_info(…)`, or `sqlite_master`;
- a `WITH` that is not the leading clause — only a leading `WITH` binds CTE
  names, and text inside a string literal or comment is not SQL at all, so
  `SELECT 'WITH customers AS (' … FROM customers` binds nothing.

Anything the scanner cannot classify is refused rather than guessed at.
Supported and unaffected: CTEs (including `RECURSIVE`, explicit column lists,
`MATERIALIZED` / `NOT MATERIALIZED`, quoted names), subqueries, joins, unions,
window functions. **A CTE never weakens the check** — being a CTE excuses only
the name, never what its body reads.

One shape is over-refused: a CTE declared *inside* a subquery
(`FROM (WITH c AS (…) SELECT * FROM c)`) is not recognised, because only a
leading `WITH` binds names. Declare the CTE at the top level instead. This
errs toward refusing valid SQL, never toward allowing a private read.

Turn it on when the source is a module that publishes a set — provisioning does
this for you. Leave it off when MOD-08 is pointed at an arbitrary customer
database: there is no contract to enforce there, and the whole schema is
exactly the point.

**When the allowed set is read.** On every check, from the source's catalog.
A view the source module publishes in a migration is usable the moment that
module has migrated — no MOD-08 restart. The consequence is that save-time and
run-time validation can legitimately disagree if the source's views change in
between: a report saved against a view that is later withdrawn starts failing
at run time, visibly, in its run history. That is intended. The source owns its
contract, and MOD-08 reporting a stale answer would be worse than an error.

`SOURCE_VIEWS_ONLY` is a **scope** restriction, not a safety mechanism. The
read-only connection remains what makes a write impossible, underneath the
SELECT-only structural check, the keyword denylist, and the row cap and
timeout (`modules/mod-08-reporting-suite/server/query-policy.ts`). It is a
fourth layer, not a replacement for any of them, and none of them were
weakened to add it.

## Non-goals

- **No cross-module joins.** One `SOURCE_DB_PATH`, one database. Two modules'
  views cannot be joined, because two modules do not share a file — that is the
  deployment model working as designed
  ([`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md)), not a gap. A report that
  genuinely needs both is the trigger for revisiting a read-model service, not
  a reason to widen this one.
- **No writes.** The contract is read-only in both directions: the consumer
  opens the file read-only, and a view is not a write target.
- **No new platform service.** This is a convention and a flag. A service that
  *delivers* read models to consumers (a "PS-12") stays unbuilt until there is
  a second consumer or a need to report across hosts.
- **No cross-host reporting.** MOD-08 reads a file on a mounted volume, so it
  and its source live in the same stack on the same host. Reporting across
  hosts needs something this design does not have and does not pretend to.
- **Not a general API.** The views are for reporting. A module that needs
  another module's data *operationally* uses the registry's `peers` mechanism
  and an HTTP call, not a database file.

## Adding a set to another module

1. Write the views into that module's `server/db.ts` as a
   `DROP VIEW IF EXISTS` + `CREATE VIEW` block run on every open. Follow the
   rules above; copy MOD-04's structure and header comment.
2. Add a `test/report-views.test.ts`: the views exist, the published columns
   are asserted by name, provisional records are excluded, cancelled records
   are marked on every row-level view, and any computed money equals the
   module's own computation for the same record.
3. Set `constraints.publishesReportViews: true` on that module's
   `modules/registry.json` entry. The generator switches a consumer into
   restricted mode off this flag, and a drift test in
   `deploy/test/registry.test.ts` re-derives it from the module's `server/db.ts`
   — claiming a contract you do not publish fails the suite.
4. Update that module's README with the published surface.
