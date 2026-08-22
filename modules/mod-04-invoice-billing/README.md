# MOD-04 · Invoice & Billing

Generate, send, and track invoices. PDF export, payment status, customer
ledger — and, in the other direction, the bills you owe with a SEPA
credit transfer file to pay them. Part of the
[0815software](https://0815software.com) module catalogue — standard
business software, MIT-licensed, always free.

Three correctness properties are the point of this module, and the test
suite proves each of them:

1. **Totals are never stored, they are derived.** An invoice stores line
   items only (quantity, unit net price in integer cents, VAT rate);
   net, VAT-per-rate and gross are always recomputed from the lines by
   one shared function — so the API, the editor preview and the PDF can
   never disagree, and nothing can drift.
2. **Numbering is gapless and sequential per year** (`INV-2026-0001`),
   the Austrian/German legal expectation. Numbers are assigned
   atomically at the moment a draft is finalized — drafts have no
   number, deleted drafts leave no gap, and a cancelled invoice keeps
   its number forever.
3. **Sent invoices are immutable.** Any edit or delete of a sent invoice
   is a 409; corrections happen via cancellation (which keeps the
   number) plus a new invoice. "Overdue" and payment status are derived
   at read time, never stored.
4. **A bill is paid once.** The module also runs the *other* direction —
   bills you owe, and the SEPA credit transfer file (`pain.001`) that
   pays them in your online banking. A bill enters at most one live
   payment run, enforced by a unique index rather than by care, and a
   produced file never changes afterwards. See
   [Bills and the SEPA payment file](#bills-and-the-sepa-payment-file).

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-03):

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| PDF      | Hand-rolled minimal writer — zero deps        |
| Styling  | Hand-rolled CSS, no framework                 |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all — the PDF generator is ~200 lines of this repository, fully
offline, no CDN, no external services.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-04-invoice-billing
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3004
npm run dev:api

# terminal 2 — UI on :5194 (proxies /api to :3004)
npm run dev:web
```

Open http://localhost:5194 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3004
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Data model

Nine tables, no stored derived state — five for money coming in, four for
money going out:

```
customers          name, email, vat_id, address              (CRUD via UI/API)
invoices           number (NULL for drafts), customer, status,
                   issue_date, due_date, payment_terms_days,
                   note, cancellation audit trail
invoice_lines      invoice, position, description, quantity,
                   unit_price_cents, vat_rate (0 | 10 | 20)
payments           invoice, date, amount_cents, note
invoice_counters   year → last_seq                           (the number source)

creditors          name, iban (validated), bic, note         (who we pay)
bills              creditor, reference, remittance, amount_cents (GROSS),
                   issue_date, due_date, note, paid_at, cancelled_at
                   UNIQUE (creditor, reference)
payment_runs       message_id (the pain.001 MsgId), execution_date,
                   FROZEN debtor name/IBAN/BIC, executed_at, discarded_at,
                   submitted_at, rejected_at, banking_order_id, bank_status
                   (the last four only when PS-12 Banking is wired)
payment_run_items  run, bill, position, end_to_end_id, amount_cents,
                   FROZEN creditor name/IBAN/BIC and remittance, active
                   UNIQUE (bill) WHERE active = 1   ← pay-once, in the schema
```

**Money** is integer cents everywhere; euros exist only at the rendering
edge. Totals per invoice are derived as:

- line net = `round(quantity × unit_price_cents)` — *per-line* rounding
  (3 × €0.33 nets €0.99, not 3 × €0.33-rounded),
- VAT = `round(sum of line nets at a rate × rate / 100)` — computed once
  per rate on the tax base,
- gross = net + VAT.

**Stored status** is only ever `draft`, `sent` or `cancelled` (enforced
by CHECKs). The API reports the *derived* status `paid` for a sent
invoice whose payments cover the gross total, payment status
(`unpaid` / `partially_paid` / `paid`) from the sum of payments, and
`overdue` from `due_date < today` — none of these exist as columns.

The payables side follows the same rule: a bill has no status column
either. `open` / `scheduled` / `paid` / `cancelled` is derived from
`paid_at`, `cancelled_at` and whether a live payment-run item points at
it, and a run's `created` / `submitted` / `executed` / `rejected` /
`discarded` from its timestamps.

One value beside them is **stored** rather than derived, and deliberately:
`bank_status` is PS-12's own word for the order. Nothing in this database can
recompute "the bank refused it" — that is the bank's fact, not ours. It also
carries the distinction that matters most: `failed` means the conversation with
the bank broke and whether the file arrived is **unknown**, so the run stays
`submitted` and its bills stay scheduled. Releasing bills whose file may be
sitting in a bank's queue is how the same invoice gets paid twice.

### Published reporting views (`report_*`)

The five tables above are **private**. What other software may read is the
set of `report_*` views this module publishes in the same database — its
reporting contract. The tables stay free to be refactored; the views are the
promise. Full stance and rules:
[`docs/REPORTING-CONTRACT.md`](../../docs/REPORTING-CONTRACT.md).

| View | One row per | Key |
| ---- | ----------- | --- |
| `report_invoices` | non-draft invoice — dates, status, customer name and VAT id, net/VAT/gross, paid, outstanding, days overdue | `invoice_number` |
| `report_invoice_lines` | invoice line, with `line_net_cents` | `invoice_number` + `line_position` |
| `report_payments` | payment, joined to invoice number and customer | `payment_id` |
| `report_receivables_aging` | customer with an open balance, in the buckets current / 1-30 / 31-60 / 61-90 / 90+ | `customer_id` |

Three things the views guarantee:

- **Drafts never appear.** No number, no issue date, not a business fact yet.
- **Money matches this module's own arithmetic exactly** — per-line net
  rounding, VAT rounded once per rate — because a report that disagrees with
  the PDF is worse than no report. A test asserts a view total equals
  `computeTotals()` for the same invoice.
- **Cancelled invoices are included and marked on every row-level view**, so a
  report can filter them instead of silently missing issued numbers:
  `report_invoices` and `report_invoice_lines` carry `status` /
  `is_cancelled`; `report_payments` carries `invoice_status` /
  `invoice_is_cancelled` (disambiguated — that view already holds
  payment-level fields). Without the flag on the line view, a plain
  `SELECT SUM(line_net_cents) FROM report_invoice_lines` would silently count
  cancelled revenue. Cancelled invoices are excluded from
  `report_receivables_aging` — a cancelled invoice is not a receivable.

The views are `DROP VIEW IF EXISTS` + `CREATE VIEW` on every open in
`server/db.ts` — no table changes, no data changes. They are rebuilt rather
than created-if-absent so a column added to the contract actually reaches a
database that already ran the migration; a view holds no data, so rebuilding
costs nothing. To read them, point MOD-08 Reporting Suite (or `sqlite3`) at the
database file. `modules/registry.json` marks this module
`publishesReportViews`, so provisioning MOD-08 with `--source-db
mod-04-invoice-billing` sets `SOURCE_VIEWS_ONLY=true` automatically and MOD-08
never sees the tables above.

## Invoice numbering rules

- Format: `INV-<year>-<seq>` with a 4-digit zero-padded sequence,
  e.g. `INV-2026-0001`.
- One independent sequence per year, driven by the `invoice_counters`
  table. The year is the year of the **issue date**.
- A number is assigned in the same SQLite transaction that flips a draft
  to `sent` ("finalize"). Drafts have no number — a CHECK constraint
  makes a numbered draft impossible.
- Deleting a draft therefore never creates a gap; sent invoices cannot
  be deleted at all (409).
- Cancelling keeps the number and records a timestamp and reason; the
  cancellation appears in the customer ledger as a balancing credit.
- The tests prove the sequence 1..last_seq exists exactly once per year
  even when several drafts are finalized concurrently.

## Lifecycle

```
draft ──finalize──▶ sent ──payments cover gross──▶ paid   (derived)
  │                   │
  delete (ok)         └──cancel (keeps number)──▶ cancelled
```

- Drafts: fully editable, deletable, no number, never on a statement.
- Sent: immutable (edits → 409), accepts payments, appears in the ledger.
- Paid: derived, not a stored state — recorded payments equal gross.
- Cancelled: keeps its number; no edits, deletes or payments (409).
  Corrections = cancel + issue a new invoice.
- **"Send" means mark-as-sent.** There is no email integration — this
  module has zero external services. Download the PDF and deliver it
  however you like.

## Features

- **Invoice list** — search on number/customer, status filter (incl.
  derived `paid` and an overdue-only view), overdue rows highlighted.
- **Invoice editor** — drafts only: customer, payment terms, note, line
  items with live derived totals (same shared money code as the server).
- **Detail view** — VAT summary per rate, payment history, record
  payment (overpayment rejected with 422), finalize / cancel / delete
  according to state, PDF download.
- **PDF export** — letterhead-style A4: 0815 monogram, seller block,
  customer block, line table, VAT summary, payment terms and bank
  details. Drafts render with a "NOT A VALID INVOICE" marker; cancelled
  invoices print as cancelled with their kept number.
- **Customers** — CRUD with validation; deletion refused (409) once a
  customer has invoices.
- **Customer ledger** — per-customer statement: invoices, cancellations
  and payments in chronological order with a running balance; the final
  balance always equals total invoiced minus total paid.
- **Bills** — what we owe: creditor, their invoice number, gross amount,
  due date, derived status, and the tick boxes that turn a selection
  into a bank file. Open / overdue / scheduled totals above the list.
- **Creditors** — who we pay and into which account, with the IBAN
  validated on entry (country, length, check digits) and the BIC
  optional, as SEPA allows.
- **Payment runs** — every `pain.001` file produced, with its message
  id, control sum, the transfers inside it, a download button, and the
  two ends: mark executed (settles its bills) or discard (releases
  them).
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, optional Secure), exactly as
  in MOD-02/MOD-03.

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                | Purpose                                  |
| ------------------- | ---------------------- | ---------------------------------------- |
| `PORT`              | `3004`                 | API / production server port             |
| `DATABASE_PATH`     | `./data.db`            | SQLite file (created on demand)          |
| `ADMIN_USERNAME`    | `admin`                | Login user                               |
| `ADMIN_PASSWORD`    | `admin`                | Login password — **change in prod**      |
| `SESSION_SECRET`    | `dev-secret-change-me` | HMAC key for the session cookie          |
| `SESSION_TTL_HOURS` | `12`                   | Session lifetime                         |
| `COOKIE_SECURE`     | `false`                | Set `true` behind HTTPS                  |
| `SELLER_NAME`       | `0815software GmbH`    | Letterhead: seller name                  |
| `SELLER_ADDRESS`    | *(example address)*    | Letterhead: address, `\|`-separated lines |
| `SELLER_VAT_ID`     | `ATU00000000`          | Letterhead: seller VAT id                |
| `SELLER_IBAN`       | *(example IBAN)*       | PDF footer **and the debtor account of every payment file** |
| `SELLER_BIC`        | `EXAMPLEX`             | PDF footer: BIC; the debtor agent when set |

The server prints a warning on startup while the default password is in
use. The dev server does not load `.env` files by itself — export the
variables in your shell or use `node --env-file`.

The shipped `SELLER_IBAN` is a placeholder whose check digits do not
add up, deliberately: until it is replaced with the real account, the
payables screens say so and refuse to build a payment file at all. An
installation cannot pay anyone from an account nobody configured.

## API

All routes under `/api`, JSON in/out, session cookie required except for
`POST /api/login` and `GET /api/health`. Money in/out is integer cents.

```
POST   /api/login                      {username, password} → session cookie
GET    /api/auth-mode                  local or SSO — which credentials to name
POST   /api/logout
GET    /api/me

GET    /api/customers                  ?search= → customers + invoice_count
POST   /api/customers                  {name, email?, vat_id?, address?}
GET    /api/customers/:id
PUT    /api/customers/:id
DELETE /api/customers/:id              409 if the customer has invoices
GET    /api/customers/:id/ledger       statement with running balance

GET    /api/invoices                   ?search=&status=&overdue=1
                                       (status: draft|sent|paid|cancelled — derived)
POST   /api/invoices                   {customer_id, payment_terms_days?, note?,
                                        lines: [{description, quantity,
                                                 unit_price_cents, vat_rate}]}
GET    /api/invoices/:id               lines, VAT breakdown, payments, derived state
PUT    /api/invoices/:id               drafts only — sent invoices → 409
DELETE /api/invoices/:id               drafts only — sent invoices → 409
POST   /api/invoices/:id/finalize      {issue_date?} draft → sent, assigns number
POST   /api/invoices/:id/cancel        {reason} — keeps the number
POST   /api/invoices/:id/payments      {amount_cents, date?, note?}
                                       overpayment → 422
GET    /api/invoices/:id/pdf           the invoice as a generated PDF

GET    /api/payment-config             the debtor account + whether it is usable

GET    /api/creditors                  ?search= → creditors + bills + open total
POST   /api/creditors                  {name, iban, bic?, note?} — IBAN validated
GET    /api/creditors/:id
PUT    /api/creditors/:id
DELETE /api/creditors/:id              409 if the creditor has bills

GET    /api/bills                      ?search=&status=&overdue=1
                                       (status: open|scheduled|paid|cancelled — derived)
POST   /api/bills                      {creditor_id, reference, amount_cents,
                                        due_date, issue_date?, remittance?, note?}
GET    /api/bills/:id
PUT    /api/bills/:id                  open bills only — scheduled/paid → 409
DELETE /api/bills/:id                  never-run open bills only → 409
POST   /api/bills/:id/cancel           open only — kept, never deleted
POST   /api/bills/:id/mark-paid        settled outside a run; scheduled → 409

GET    /api/payment-runs               the runs + the debtor config
POST   /api/payment-runs               {bill_ids: [], execution_date?} → the run
GET    /api/payment-runs/:id           the frozen transfers inside it
GET    /api/payment-runs/:id/sepa.xml  THE FILE — pain.001.001.03, as a download
POST   /api/payment-runs/:id/submit    send it to the bank via PS-12 (BANKING_URL)
POST   /api/payment-runs/:id/refresh   re-read the bank's word on a sent run
POST   /api/payment-runs/:id/mark-executed  the bank executed it → bills settled
POST   /api/payment-runs/:id/discard   not uploaded → bills back to open
```

Validation failures return `422` with `{error, details: [{field,
message}]}`; state conflicts (editing/deleting a sent invoice, paying a
draft, double-cancelling) return `409`.

## Scripts

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` proxy                       |
| `npm run seed`    | Create/seed the SQLite database (skips non-empty DBs)   |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | Invariant + API tests (Vitest, in-memory SQLite)        |

The tests prove the properties that matter: gapless sequential numbering
across concurrent finalizations, sent-invoice immutability (409),
per-line rounding and mixed-VAT totals (incl. 3 × €0.33), payment status
transitions with overpayment 422, ledger running balance = invoiced −
paid, cancelled invoices keeping their numbers, a valid `%PDF` response,
and 401 everywhere without a session. `test/report-views.test.ts` covers the
published contract: the views exist with exactly the documented columns,
drafts are excluded, a view's totals equal `computeTotals()` for the same
invoice, the aging buckets are correct *on* their boundaries, every published
line and payment row carries its invoice's cancellation state, and re-opening
a database rebuilds the views so an added column reaches an existing
deployment.

`test/sepa.test.ts` and `test/bills.test.ts` cover the payables half:
IBAN check digits, non-SEPA countries and the placeholder `SELLER_IBAN`;
the SEPA character set; the exact bytes of a rendered `pain.001.001.03`
(golden file, element order included) and that rendering it twice is
identical; refusing to pay a bill that is already in a run, both through
the API and at the unique index; a run's frozen creditor surviving a
later IBAN correction; discard releasing the bills and never reusing a
`MsgId`; and mark-executed settling every bill in the run.

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`), `COOKIE_SECURE=true` and your real
  `SELLER_*` values, and terminate TLS in front (Caddy/nginx).
- Not a fit for serverless platforms: SQLite wants a persistent filesystem.

## Platform integration (optional)

mod-04 can consume the shared [Platform Services](../../platform) through the
[`@0815software/platform-clients`](../../platform/clients) package. When the
matching `*_URL` env vars are set, **issuing an invoice** also:

- emails the customer via **PS-03 Notification Hub**,
- archives the rendered PDF in **PS-06 File Storage**, and
- records an `invoice.issued` event on **PS-07 Audit Log**.

With `PAYMENTS_URL` set, `POST /api/invoices/:id/pay` collects an invoice's
open balance via **PS-08 Payments** (recording the payment on a synchronous
success); without it, that endpoint returns `501`.

With `NUMBER_URL` set, invoice numbers are sourced from **PS-10 Number**
(authoritative, gapless) instead of the local per-year counter.

With `CUSTOMERS_URL` set, an imported customer is resolved against
**PS-11 Customers** — the stack's party master data — instead of being copied
blind, so this module and MOD-13 Offers mean the same customer. The resolved
party id is stored on the local customer row; unset, the module matches against
its own `customers` table as it always has.

With `BANKING_URL` set, a payment run can be **sent** to the bank over EBICS
through **PS-12 Banking** instead of downloaded and uploaded by hand — see
[Bills and the SEPA payment file](#bills-and-the-sepa-payment-file). This
module still holds no keys and speaks no bank protocol; it hands PS-12 the same
bytes the download serves, and PS-12 signs them. `BANK_CONNECTION` names which
of its connections to submit against (default `main`). Unset, the download is
the only path — which is the default and what most installations want.

Unlike every other hook here, **this one is not best-effort**: an error
propagates instead of becoming a warning, because a swallowed failure would
leave an operator believing a payment was sent.

With `AUDIT_URL` set, every payment-run event — `payment_run.created`,
`payment_run.submitted`, `payment_run.rejected`, `payment_run.executed`,
`payment_run.discarded`, with the message id, the transfer count and the
total — is recorded on **PS-07 Audit Log**. Money leaving the company is what
an audit log is for, and without a bank connection the file itself lives only
in whoever downloaded it, so the trail has to be in the stack. Unset, nothing
is sent and the runs are their own record.

### The seller letterhead

The `SELLER_*` env vars are the fallback, not the source of truth. With
`CUSTOMERS_URL` set, this module reads PS-11's `self` party — the stack owner's
own record — at boot and refreshes it every five minutes
(`SELLER_REFRESH_MS`), so the name, address and VAT id printed on invoice PDFs follow
a change made once in PS-11 rather than needing two `.env` edits and a redeploy.
Precedence is per field: anything the `self` party leaves blank falls back to the
env, so a half-filled party cannot blank a letterhead, and an unreachable PS-11
leaves the env in charge. The module never writes the seller back — one
authority. See `server/seller.ts`.

Every call is best-effort — a downstream outage is logged and never fails the
invoice — and entirely opt-in: with the URLs unset (`NOTIFICATION_URL`,
`FILES_URL`, `AUDIT_URL`, `PLATFORM_SERVICE_TOKEN`) the module behaves exactly
as before, standalone, with no outbound calls. See `server/platform.ts`.

## Billing an accepted offer

`POST /api/invoices/import-offer` with `{ "offer_number": "AN-2026-0007" }` turns
an accepted offer from **MOD-13 Offers** into a draft invoice — the *IMPORT
OFFER* action in the invoice list. It is the module's one cross-module
dependency, and it is deliberately narrow:

- **The wire format is a contract, not an accident.** `shared/transfer.ts` defines
  a neutral document transfer — customer identity, line items, currency, VAT,
  totals — with none of MOD-13's ids, statuses or revision chain in it. The same
  file exists on the MOD-13 side.
- **The money is self-checking.** Every transferred line carries the net the
  source computed and the document carries the source's totals; this module
  recomputes both and **refuses the transfer if they disagree**, so a rounding
  difference between two modules can never become a wrong invoice. A per-line
  discount (which invoice lines cannot express) is folded into a single-quantity
  line at its exact net, with the arithmetic spelled out in the description.
- **It produces a DRAFT.** The operator still reviews and finalizes; nothing is
  issued behind their back.
- **It is idempotent on the offer number,** which is recorded on the invoice
  (`origin_offer_number`, unique). A retry — or a double click — returns the first
  invoice with `200` instead of creating a second one.
- **Only accepted offers.** MOD-13 refuses to export a draft, a merely sent, a
  rejected, a withdrawn or a superseded offer, and the reason is passed through.
- **Never a pipeline deal.** The same transfer shape can carry one — MOD-10
  exports deals so MOD-13 can quote them — and a deal validates perfectly well
  as a shape. Its money is the part that differs: one salesperson's estimate, at
  a rate the CRM did not choose, for something nobody has agreed to buy. This
  module refuses it explicitly and says to quote it first.
- **It is optional.** With `OFFERS_URL` unset the endpoint answers `501` and this
  module has no notion of offers at all. The full test suite passes either way.

The transport is isolated in `server/platform.ts` (`fetchOffer`) and the shape in
`shared/transfer.ts`, so re-pointing it at another source is a contained change.
See [`docs/CUSTOMER-MASTER-DATA.md`](../../docs/CUSTOMER-MASTER-DATA.md) for why
this exists and what it deliberately does not solve.

## Bills and the SEPA payment file

The other direction of the module: the bills your suppliers send you, and
the file that pays them. Record a bill, tick the ones to pay, and download a
**pain.001.001.03 SEPA credit transfer** — the ISO 20022 file every Austrian
and German online banking accepts as a payment upload, and the payload an
MBS / EBICS channel carries. Upload it, authorise it at your bank, come back
and mark the run executed.

```
creditor (IBAN validated)
   └── bill  ── select ──▶ payment run ── download ──▶ your online banking
        │                     │   │  └── send ──▶ PS-12 ──▶ the bank (optional)
        │              discard│   │mark executed ◀── the bank executes it
        ▼                     ▼   ▼
   mark paid / cancel     bills open again / bills paid
```

### Finanzamtszahlung

A payment to an Austrian tax office is an ordinary SEPA credit transfer with
three things added. `POST /api/payment-runs` takes `category_purpose: "TAXS"`
and applies it to every payment in the run.

**The mark goes on each transaction, not on the batch.** *Finanzamtszahlung in
EBICS* allows it in exactly one place — `<Purp><Cd>TAXS</Cd></Purp>` inside the
`CdtTrfTxInf` — and says coding it at batch level "ist nicht vorgesehen" *even
when every payment in the batch is one*. The run-wide flag here is an operator
convenience; the code still lands per transfer, so a run may hold a tax payment
beside an ordinary supplier payment.

**The remittance is PSA's published format**, shipped and pinned to every
example in both documents:

```
(\d{2}(\d{2}(/?\d{2})?)?([-+](0|([1-9]([0-9]{0,10})?))[A-Z]{1,3})+)+
```

A period — `YY`, `YYMM`, `YYMMDD` or `YYMM/MM` — then amounts in cents, `+` a
liability and `-` a credit, each with a one-to-three letter kind of tax, all
repeated: `0811+676850L+176800DB+23601DZ0810-563910U`.

**The 9-digit Ordnungsbegriff travels in `EndToEndId`** — the tax account the
office books against — so a TAXS run uses the bill's reference verbatim rather
than prefixing it with the bill id, and its check digit is verified. There is
deliberately no check that the office number matches the IBAN: after the 2020
mergers a tax number outlives its office, and the specification says such
checks "sind daher auszubauen".

`shared/finanzamt.ts` carries all 35 collection accounts from the
specification's annex, so a creditor row says which office an IBAN belongs to.
It is a **hint, not a gate**: the annex is marked "NICHT NORMATIV" and warns
the list changes, and blocking a payment to a newly created office would be the
worse failure. Every IBAN in it is check-digit verified by its own test, since
a transcription slip there would misroute a tax payment.

`AT_TAXS_REMITTANCE_PATTERN` overrides the format check for a bank stricter
than PSA. It replaces that check only — the 140-character cap, the empty
remittance refusal and the check digit stand either way.

One inconsistency to know about, because it will be reported as a bug: the
specification's own §4 narrative example uses tax account `023765641`, which
does **not** satisfy the check-digit rule stated and worked through in §3.1
(`269135729`, which does). The rule is implemented as §3.1 defines it.

**Postbarzahlung is not built here.** A CPPP payment goes to BAWAG PSK's
collection account with the real recipient in `UltmtCdtr` and a CashPerPost
reference in `EndToEndId` — none of which a bill from a creditor can express.
Flagging one correctly and addressing it wrongly is worse than not offering it.
PS-12 knows the format and checks any file that carries the mark.

### Saying what a payment settles

`structured_remittance: true` on a payment run writes each `Ustrd` in the
**EACT** form instead of free text:

```
/CINV/SW-2026-004512/ 384.20/ 20260602
```

The European Association of Corporate Treasurers defines this so the 140
characters can carry invoice references, applied amounts and dates that survive
the whole European payment chain — and that the creditor's ledger can match
without a human reading them. The component separator is a slash **followed by
a space**, which is what lets a reference contain a slash of its own.

Two things worth knowing. An element is never cut in half to fit: a caller that
overflows 140 characters is told which elements did not make it, because a
payment naming four of its six invoices is worse than one naming none — the
supplier reconciles four and chases two that look unpaid. And EACT's `/URL/`
example is an email address, which **cannot travel in a SEPA `Ustrd` at all**:
the character set has no `@`, so it arrives with that character replaced.

A Finanzamtszahlung is never restructured — its `Ustrd` has its own grammar.

### What it does not do — and why

**This module holds no bank credentials and speaks no bank protocol.** It
writes a file. That boundary has not moved: an EBICS client means subscriber
keys, certificates and INI/HIA/HPB onboarding per bank and per customer, and a
key that can move money has no business sitting in a CRUD app beside the
invoice table.

What changed is where that work lives. **PS-12 Banking** is a Platform Service
that does hold those keys, in one guarded place, and MOD-04 reaches it over an
API like any other service:

- `BANKING_URL` **unset** — the default, and what most installations want — and
  this module behaves exactly as described above. Download, upload, mark
  executed. No outbound calls, no keys, nothing to certify.
- `BANKING_URL` **set** — a "Send via EBICS" button appears beside "Download
  XML" and hands the same bytes to PS-12, which signs them and talks to the
  bank. **The download never goes away**, because a bank connection is optional
  and the file is the fallback for the day the connection is down.

And in the other direction: PS-12 collects the bank's **payment status
reports** (`pain.002`) and folds them back, so a run settles itself. A report
saying the money moved (`ACSC`) marks the run executed and its bills paid; one
saying the bank refused it releases the bills back to `open` for a corrected
run. Nobody has to come back and press "mark executed" — though the button
stays, because a bank that sends no status reports is still a bank.

The file stays the standardised part either way. Every bank takes it, nothing
here has to be certified against any bank's API, and an outage at the bank
cannot break bookkeeping.

The file is a valid pain.001.001.03 per the ISO 20022 schema (the shipped
example output is validated against the official XSD).

> **A deadline worth knowing about.** The German BTF mapping table (`ebics.de`,
> 27 February 2026) says that from **11/2026 only pain.001.001.09** is usable
> for SEPA credit transfers under GBIC 4/5, and only pain.002.001.10 for status
> reports. This module still produces **.03**. Moving is not a version bump —
> .09 is the ISO 2019 schema, with structured creditor addresses among other
> changes — so it wants its own pass, and this note is here so it does not
> arrive as a surprise.
 Banks still differ in
what they accept — some insist on a BIC, some cap the number of transfers,
some want a lead time on the execution date. **Run one file through your
bank's file check before the first live upload**, the same way MOD-06's ERP
export profiles are examples rather than certifications.

### The five rules the tests pin

1. **A bill is paid once.** A bill enters at most one *live* payment run.
   `server/bills.ts` checks it and answers 409; a partial unique index
   (`payment_run_items (bill_id) WHERE active = 1`) makes it impossible
   rather than merely checked. Everything else about payables is
   recoverable — paying a supplier twice is the one mistake that costs real
   money and takes weeks to get back.
2. **A produced file never changes.** A run freezes the debtor account and
   every transfer's creditor name, IBAN, BIC, amount and remittance at the
   moment it is created. Correcting a supplier's IBAN afterwards changes the
   *next* run, never the file the bank already holds — and downloading a run
   again yields byte-identical XML, because the identifiers and the creation
   timestamp are stored, not regenerated. (A bank rejects a second file with
   a `MsgId` it has seen; that is the protection, and it only works if the
   same run keeps the same id.)
3. **An unusable own account stops everything, early.** The debtor is
   `SELLER_IBAN` — the same account printed on your invoices. The shipped
   placeholder fails its check digits on purpose, so a fresh installation
   says so on the screen and refuses to build a run, instead of producing a
   file the bank bounces after everyone has stopped looking.
4. **Only characters the scheme allows reach the file.** "Müller & Söhne"
   becomes "Mueller + Soehne" deterministically (`shared/sepa.ts`), accents
   are dropped to their base letter, and anything else becomes a space —
   never a rejected file, and never a silently mangled payee.
5. **A run reaches the bank at most once, and the bytes are the bytes.**
   With PS-12 wired, a run already sent is refused locally before it reaches
   the service that would sign it, and cannot be discarded — releasing bills
   whose file may be in a bank's queue is rule 1 all over again. What is sent
   is `paymentRunXml`, the same function the download serves, so an operator
   falling back to uploading by hand uploads the identical file. Rule 1 still
   holds across the boundary: PS-12 deduplicates on the run's own `MsgId`, so
   even a lost idempotency key cannot pay twice. And what the bank later says
   about it wins: a run accepted at upload and refused by a `pain.002` two days
   later ends up `rejected`, with its bills released, not quietly "sent".

### Money, and what a bill is not

A bill's `amount_cents` is the **gross amount to transfer** — what the
supplier's invoice says is due. Bills carry no VAT split, no line items and
no tax logic: a bill is a payment instruction, not a tax document, and
inventing a VAT breakdown in the screen least qualified to choose a rate
would be worse than not having one. Your bookkeeping is where the split
belongs. Money stays integer cents until the two-decimal string the schema
demands, and the file's `CtrlSum` is summed from those same integers, so it
can never be a rounding of a rounding.

### Field by field

| pain.001 element | Comes from |
| ---------------- | ---------- |
| `GrpHdr/MsgId` | `MOD04-<date>-<8 hex>`, generated once and stored — the bank's duplicate check |
| `CreDtTm` | when the run was created (stored, so the file is reproducible) |
| `NbOfTxs` · `CtrlSum` | counted and summed from the run's own transfers |
| `ReqdExctnDt` | the execution date on the run; today by default, never in the past |
| `Dbtr` · `DbtrAcct` | `SELLER_NAME` / `SELLER_IBAN` (or the PS-11 `self` party) |
| `DbtrAgt` | `SELLER_BIC`, or `Othr/Id = NOTPROVIDED` when unset — SEPA is IBAN-only |
| `BtchBookg` | `false`: one statement line per payment, so each keeps its own trail |
| `ChrgBr` | `SLEV` — the only charge bearer a SEPA credit transfer allows |
| `EndToEndId` | `B<bill id>-<their reference>`, ≤ 35 chars — what comes back on the statement |
| `Cdtr` · `CdtrAcct` · `CdtrAgt` | the creditor, frozen into the run; `CdtrAgt` omitted without a BIC |
| `RmtInf/Ustrd` | the bill's payment reference (its `remittance`, else the supplier's invoice number) |
| `RmtInf/Strd` | used instead when that reference is a valid ISO 11649 `RF…` creditor reference, as `SCOR` |

### Trying it

```sh
export SELLER_IBAN="AT61 1904 3002 3457 3201"   # your own account
npm run seed && npm start
```

Sign in, open **Bills** (the seed ships four creditors and six bills), tick
the open ones, pick an execution date and press *Create payment file*. The
run opens with its transfers listed; **Download XML** is the file. Or from
the API:

```sh
curl -s -b cookie.txt -X POST localhost:3004/api/payment-runs \
  -H 'Content-Type: application/json' -d '{"bill_ids":[1,2]}'
curl -s -b cookie.txt localhost:3004/api/payment-runs/1/sepa.xml
```

Validate the result against the schema if you want to see it for yourself:

```sh
xmllint --noout --schema pain.001.001.03.xsd sepa-mod04-….xml
```

With `BANKING_URL` pointed at a PS-12 with a live connection, the same run has
a **Send via EBICS** button beside the download, and:

```sh
curl -s -b cookie.txt -X POST localhost:3004/api/payment-runs/1/submit
```

answers with the run carrying `status: "submitted"`, the bank's order id and
its verdict.

## Out of scope

Kept out deliberately to stay a 3–4 week module. If you need any of
these, that's commissioned work — exactly the kind 0815software does:

- **Sending email** — standalone, "send" means mark-as-sent and assigns the
  number (no SMTP). Real delivery is available opt-in via PS-03 (see above).
- **Multi-user accounts and roles** — one staff admin by design (same
  auth pattern as MOD-02/03). No per-user audit trail.
- **Other currencies and VAT regimes** — EUR only, Austrian rates
  (0/10/20%). Reverse-charge is just a 0% line with a note.
- **Recurring invoices, quotes, dunning runs** — the clean REST API is
  the hook for automation; reminders are a note field, not a workflow.
- **Formal credit notes** — corrections are cancellation + new invoice.
  A credit-note document type (negative invoice) is an extension.
- **Bank reconciliation / payment import** — payments are recorded
  manually or via the API; no CAMT/MT940 parsing, no PSP integration.
  The payment file goes out; nothing comes back in automatically, which
  is why marking a run executed is a human action.
- **e-Invoicing formats** (ebInterface, XRechnung, ZUGFeRD/Factur-X) —
  the PDF is a plain human-readable document.
- **EBICS (or any other) bank transport** — the module produces the file
  and stops there; see
  [Bills and the SEPA payment file](#bills-and-the-sepa-payment-file).
- **Other payment message versions and schemes** — `pain.001.001.03`
  only. `pain.001.001.09` is a small addition to one renderer
  (`shared/sepa.ts`) when your bank requires it; SEPA Direct Debit
  (`pain.008`, collecting from customers) needs mandates, which is a
  data model this module does not have.
- **Approval before payment** — whoever can sign in can produce a file.
  The bank's own authorisation is the second pair of eyes; multi-tier
  approval of a payment run is the MOD-06 pattern, not this module's.

## License

MIT © 0815software — see [LICENSE](LICENSE).

## The shell contract — appearing on a dashboard

`GET /api/summary`, guarded by `PLATFORM_SERVICE_TOKEN`, is how this module
puts figures and short lists on a [MOD-15 Workspace](../mod-15-workspace)
board. The shape is `shared/summary.ts`, byte-identical in every module; the
values are computed by the same functions this module's own screens read, so a
widget cannot disagree with the module beside it.

Set `SHELL_ORIGIN` to the Workspace's origin and two more things follow: this
module can be framed by that one shell (`frame-ancestors` replaces the blanket
`X-Frame-Options: DENY`), and `POST /api/session/handoff` / `POST
/api/session/issue` open, so the Workspace can obtain a session for whoever is
using it. This module still mints its own sessions — the shell only asserts
who, and only because it holds the machine token and was named here.

With both unset — the default, and what a standalone install runs — the summary
endpoint is closed, the handoff routes are not mounted, and framing is denied
outright. See [`docs/SHELL-CONTRACT.md`](../../docs/SHELL-CONTRACT.md).
