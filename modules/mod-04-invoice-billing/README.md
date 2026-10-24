# MOD-04 · Invoice & Billing

Generate, send, and track invoices. PDF export, payment status, customer
ledger — and, in the other direction, the bills you owe with a SEPA
credit transfer file to pay them. Part of the
[0815software](https://0815software.com) module catalogue — standard
business software, MIT-licensed, always free.

Five correctness properties are the point of this module, and the test
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
   A bill for a MOD-06 purchase order is paid only when the three-way match
   says what arrived covers it — or a manager released it with a reason. See
   [Matched against the purchase order](#matched-against-the-purchase-order-mod-06).
5. **An issued invoice keeps saying what it said.** Finalizing freezes the
   seller and the buyer into the invoice; the PDF, the XRechnung and the
   ZUGFeRD file are rendered from that copy, so a later address change never
   rewrites an invoice already sent — and every e-invoice file is produced only
   when it validates. See [E-invoices](#e-invoices-xrechnung-and-zugferd).

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-03):

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| PDF      | Hand-rolled minimal writer — zero deps        |
| PDF/A-3  | Same writer + TrueType subsetting (ZUGFeRD)   |
| Styling  | Hand-rolled CSS, no framework                 |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all — the PDF generator is ~200 lines of this repository, fully
offline, no CDN, no external services. The PDF/A-3 container for ZUGFeRD
(`server/pdfa.ts`, `server/ttf.ts`) is equally dependency-free; it embeds
Liberation Sans / Mono, shipped in `assets/fonts` under the SIL Open Font
License.

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

Fifteen tables, no stored derived state — money coming in, reminding
and repeating it, and money going out:

```
customers          name, email, vat_id, address              (CRUD via UI/API)
                   + street, postcode, city, country_code, buyer_reference,
                   einvoice_address, debtor_account   (all optional)
invoices           number (NULL for drafts), customer, status,
                   issue_date, due_date, payment_terms_days,
                   note, cancellation audit trail,
                   buyer_reference, delivery_date, tax_exemption_category
                   / _reason, seller_snapshot / buyer_snapshot (JSON,
                   frozen at finalize — see E-invoices)
invoice_lines      invoice, position, description, quantity,
                   unit_price_cents, vat_rate (0 | 7 | 10 | 13 | 19 | 20)
payments           invoice, date, amount_cents, note
invoice_counters   year → last_seq                           (the number source)
accounting_settings  one row: DATEV / BMD export settings (JSON), who saved it
seller_settings      one row: the seller fields the admin set (JSON), who saved it
dunning_settings     one row: the dunning levels (JSON), who saved it
dunning_notices      invoice, level, what was claimed and the letter text
                     UNIQUE (invoice, level)   ← append-only
credit_notes         invoice, seq, number (<invoice>-GS<seq>), issue_date,
                     reason, actor   UNIQUE (invoice, seq) ← never updated
credit_note_lines    credit note, position, description, quantity,
                     unit_price_cents, vat_rate (positive, like any 381)
recurring_invoices   name, customer, interval, start/end date, active,
                     the draft it produces (JSON)
recurring_runs       template, period start/end, the draft it produced
                     UNIQUE (template, period_start)   ← once per period

creditors          name, iban (validated), bic, note         (who we pay)
bills              creditor, reference, remittance, amount_cents (GROSS),
                   issue_date, due_date, note, paid_at, cancelled_at,
                   po_number?, net_cents?            (the MOD-06 PO it is for)
                   UNIQUE (creditor, reference)
bill_match_checks  APPEND-ONLY: bill, result, message, ordered/received/invoiced/
                   tolerance cents, actor, checked_at   (every answer MOD-06 gave)
bill_match_releases APPEND-ONLY: bill, check, reason, actor  (a held verdict released)
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
  delete (ok)         ├──credit note (-GS1, -GS2 …)──▶ sent, owes less
                      └──cancel (keeps number)──▶ cancelled
```

- Drafts: fully editable, deletable, no number, never on a statement.
- Sent: immutable (edits → 409), accepts payments, appears in the ledger.
- Paid: derived, not a stored state — recorded payments equal gross.
- Cancelled: keeps its number; no edits, deletes or payments (409).
  A wrong invoice = cancel + issue a new one.
- Credited in part: a partial credit note takes back part of a correct
  invoice (see [Partial credit notes](#partial-credit-notes-teilgutschriften));
  a credited invoice is not cancelled on top (409).
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
- **E-invoices** — XRechnung 3.0 (XML), ZUGFeRD (PDF/A-3, EN 16931) and the
  Austrian ebInterface 6.1 (XML, for e-Rechnung.gv.at) for every issued invoice, and for a cancellation as a credit note; the detail
  view lists exactly what is still missing, by EN 16931 business term.
- **Dunning** — overdue invoices with the reminder each needs next, level by
  level; every notice that goes out is stored and its letter stays
  downloadable as sent. Optional email through PS-03.
- **Exports** — the issued invoices of a period as a DATEV Buchungsstapel or a
  BMD NTCS booking import.
- **Settings** — the seller (letterhead, bank account, XRechnung contact and
  register data) and the DATEV / BMD settings. Everyone with a level may read
  them; saving needs **`manage`**. Every field shows where its value comes
  from; every save records who and when.
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, optional Secure), exactly as
  in MOD-02/MOD-03.

## Configuration

All via environment variables (see [`.env.example`](.env.example)). The
`SELLER_*` values are **starting values only**: the seller is maintained on
the Settings screen by whoever holds `manage`, and what is saved there wins (see
[E-invoices](#e-invoices-xrechnung-and-zugferd) and
[`docs/E-RECHNUNG.md`](../../docs/E-RECHNUNG.md)).

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
| `SELLER_STREET` · `SELLER_POSTCODE` · `SELLER_CITY` · `SELLER_COUNTRY` | *(read from `SELLER_ADDRESS`)* | E-invoice: structured seller address (BT-35/38/37/40) |
| `SELLER_TAX_NUMBER` | —                      | E-invoice: German Steuernummer (BT-32)   |
| `SELLER_REGISTRATION` | —                    | E-invoice: register number, e.g. `HRB 12345` (BT-30) — needed without a VAT id |
| `SELLER_CONTACT_NAME` · `SELLER_PHONE` · `SELLER_EMAIL` | — | E-invoice: seller contact — mandatory for XRechnung (BT-41/42/43) |
| `SELLER_EINVOICE_ADDRESS` | *(`SELLER_EMAIL`)* | E-invoice: seller electronic address (BT-34) |
| `PROCUREMENT_URL` | — | MOD-06 Procurement: match bills naming a PO before they are paid |
| `AI_URL` | — | PS-04 AI Platform: read a supplier invoice (e-invoice, PDF, scan) into the bill form |

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
POST   /api/invoices/import-delivery-note  {delivery_note_number} — bill one MOD-17 delivery (501 without ORDERS_URL)
POST   /api/invoices/:id/finalize      {issue_date?} draft → sent, assigns number
POST   /api/invoices/:id/cancel        {reason} — keeps the number (409 once credited)
POST   /api/invoices/:id/credit-notes  {reason, lines, issue_date?} — partial credit note
GET    /api/invoices/:id/credit-notes/:noteId/pdf   the credit note as a PDF
POST   /api/invoices/:id/payments      {amount_cents, date?, note?}
                                       overpayment → 422
GET    /api/invoices/:id/pdf           the invoice as a generated PDF
GET    /api/invoices/:id/einvoice      what XRechnung / ZUGFeRD / ebInterface would still refuse
GET    /api/invoices/:id/xrechnung.xml ?document=cancellation · ?credit_note=<id>
GET    /api/invoices/:id/ebinterface.xml  ebInterface 6.1; ?document=cancellation · ?credit_note=<id> (CreditMemo)
GET    /api/invoices/:id/zugferd.pdf   PDF/A-3 with factur-x.xml; same parameters
GET    /api/einvoice-config            the seller as e-invoices see it + what is missing

GET    /api/dunning                    overdue invoices, where each stands (derived), the levels
POST   /api/invoices/:id/dunning-notices   issue the next notice if due (409 otherwise)
POST   /api/dunning/run                every due notice at once (manage)
GET    /api/dunning-notices/:id/pdf    the letter, as it went out
GET    /api/dunning-settings · PUT (manage)   levels, days between notices, interest rate

GET    /api/recurring                  templates, each with due periods (derived)
POST   /api/recurring · PUT/DELETE /api/recurring/:id   (409: start locked / has history)
POST   /api/recurring/:id/generate     a draft per due period, at most once each
POST   /api/recurring/run              every template at once (manage)

GET    /api/settings/seller            the seller: each field, its value and source
PUT    /api/settings/seller            the admin's overrides — empty falls back
GET    /api/accounting-settings        DATEV / BMD settings + suggested accounts
PUT    /api/accounting-settings
GET    /api/exports/datev.csv          ?from=&to=&payments=1 — EXTF Buchungsstapel
GET    /api/exports/bmd.csv            ?from=&to= — BMD NTCS booking import

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
POST   /api/bills/:id/check-match      ask MOD-06 again (501 without PROCUREMENT_URL)
POST   /api/bills/:id/release-match    {reason} — pay a held bill anyway (manage)
POST   /api/bills/read                 {content_base64, content_type, filename} → {extraction,
                                        proposal} — PS-04 reads, nothing saved (501 without AI_URL)
GET    /api/settings/bill-reading      {model, available} — which model may read documents
PUT    /api/settings/bill-reading      {model: null|anthropic|openai|gemini|ollama|kimi} (manage)

GET    /api/payment-runs               the runs + the debtor config
POST   /api/payment-runs               {bill_ids: [], execution_date?} → the run
GET    /api/payment-runs/:id           the frozen transfers inside it
GET    /api/payment-runs/:id/sepa.xml  THE FILE — pain.001.001.03, as a download
POST   /api/payment-runs/:id/submit    send it to the bank via PS-12 (BANKING_URL)
POST   /api/payment-runs/:id/refresh   re-read the bank's word on a sent run
POST   /api/payment-runs/:id/mark-executed  the bank executed it → bills settled
POST   /api/payment-runs/:id/discard   not uploaded → bills back to open

GET    /api/receivables/suggestions    what arrived, matched to open invoices
POST   /api/receivables/apply          record what a human confirmed
```

The last two answer **501 without a bank connection**, which is not a failure:
a payment is recorded on the invoice itself, exactly as it always was.

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

`test/dunning.test.ts` pins the reminder rules: levels in order with the
minimum gap, a payment ending the run, one notice per level at the unique
index, and a letter that renders byte-identical on every download.
`test/credit-notes.test.ts` pins the credit-note rules: its own numbering,
the per-rate cap on base *and* VAT (the rounding cent included), the
derived open amount, payment cap and paid status, no cancellation on top,
the ledger and reporting views agreeing, the export booking it on its own
date, and the 381 / CreditMemo against both schemas.
`test/recurring.test.ts` pins the recurring rules: month-end clamping
without drift, at most one draft per period (also at the unique index), a
deleted draft not being regenerated, bounded catch-up, the end date, the
start-date lock and the access levels.

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

### Incoming payments — the other direction, and equally optional

With `BANKING_URL` set, the same connection can be read back: what actually
arrived on the account, matched against invoices that are still open.
**Incoming payments** in the navigation shows the proposals; ticking one
records an ordinary payment on the invoice.

Three things are worth being explicit about, because they are what stops this
becoming a liability rather than a convenience.

**It is a convenience.** `POST /api/invoices/:id/payments` — a human typing the
amount — is the primary path and always will be. Without a bank connection the
screen says so and points back at the invoice; nothing about getting paid
depends on having one. This only removes the typing.

**The matching rules are this module's own.** They live in
[`shared/matching.ts`](shared/matching.ts), which imports nothing at all and
works on a `BankBooking` shape defined here, not on the platform service's
type. Taking PS-12's type would have quietly made receivables matching a
feature of having a platform. Bookings from a bank connection today; from a CSV
somebody exports, or a second source, without touching the rules.

**Nothing is recorded without a person.** `suggestions` proposes and `apply`
writes, deliberately as two calls. Every proposal carries HOW it was matched —
the payer quoting the invoice number is not the same evidence as "this is the
only open invoice for that amount", and the screen starts the two weak kinds
unticked. Ambiguity is reported rather than resolved: two open invoices for the
same amount is ordinary, and "the oldest" is a tie-break that would be wrong
about half the time.

What it does handle without asking: a collective payment naming several
invoices is spent across them in order; a part payment is proposed as a part
payment; a debit and a reversal are never proposed at all.

**One arrival becomes at most one payment.** `payments.external_ref` holds the
booking's identity under a UNIQUE index, and that identity is built from what
the *bank* said — not from the row that delivered it, because a statement can
be re-read from its stored bytes and row ids change underneath.

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

Above both sits the **Settings** screen (saving needs `manage`): a field saved there wins over
PS-11 and the env — except the fields PS-11 carries, which stay read-only while
`CUSTOMERS_URL` is set, so there is still one place to change the company
name. A PS-11 refresh never undoes an admin's save; both are inputs to the
same computation (`server/seller-settings.ts`).

Every call is best-effort — a downstream outage is logged and never fails the
invoice — and entirely opt-in: with the URLs unset (`NOTIFICATION_URL`,
`FILES_URL`, `AUDIT_URL`, `PLATFORM_SERVICE_TOKEN`) the module behaves exactly
as before, standalone, with no outbound calls. See `server/platform.ts`.

## E-invoices: XRechnung and ZUGFeRD

From **1 January 2027** a German business whose previous-year turnover exceeded
**€800,000** must issue its domestic B2B invoices as e-invoices (§ 14 UStG as
amended by the Wachstumschancengesetz); everyone else follows on 1 January
2028, and every business must already be able to receive them. A PDF by email
is not an e-invoice. This module issues both formats the law accepts in
practice:

| Format | What it is | Download |
| ------ | ---------- | -------- |
| **XRechnung 3.0** | EN 16931 with the German CIUS (KoSIT), CII syntax — required by German public bodies | `GET /api/invoices/:id/xrechnung.xml` |
| **ZUGFeRD 2.x / Factur-X, profile EN 16931** | a PDF/A-3 a person reads, with the same XML embedded as `factur-x.xml` | `GET /api/invoices/:id/zugferd.pdf` |
| **ebInterface 6.1** | the Austrian format (AUSTRIAPRO) — for e-Rechnung.gv.at and Austrian recipients; carries the federal supplier number and order reference | `GET /api/invoices/:id/ebinterface.xml` |

Both come from **one model and one renderer** (`shared/einvoice.ts`), fed by
the invoice as issued (`server/einvoice-data.ts`). The money is this module's
own — per-line rounding, VAT once per rate — which is exactly what the
EN 16931 rules recompute, so the XML states the PDF's figures to the cent.

- **Refused rather than wrong.** A file is only produced when it would
  validate. Otherwise `422` lists every missing field with its business term
  (`BT-49: XRechnung requires the buyer electronic address …`), and the
  invoice screen shows the same list before anyone downloads.
- **Frozen at issue.** Finalizing copies seller and buyer into the invoice;
  re-downloading next year gives the same file. Invoices issued before this
  release have no copy and read today's master data (`parties_frozen: false`).
- **0 % needs a reason.** A draft with 0 % lines names its VAT category —
  `E` exempt (with the legal ground), `AE` reverse charge, `K` intra-EU supply,
  `G` export, `Z` zero-rated, `O` not subject — and the reason is printed on
  the PDF and written to the XML.
- **A cancellation is a document.** A cancelled invoice keeps its original
  e-invoice; its cancellation is a credit note (type 381, number
  `<invoice>-ST`) referring to it — `?document=cancellation`.
- **Validated outside this repository.** Every case in
  `test/einvoice-cases.ts` passed Mustang (EN 16931 + XRechnung 3.0
  schematron, veraPDF for PDF/A-3b) before its golden file was committed; the
  suite pins those bytes and checks the Factur-X XSD on every run.
  `npm run einvoice:validate` repeats the external check (needs Java).

What to set up, field by field, and what is deliberately not covered:
[`docs/E-RECHNUNG.md`](../../docs/E-RECHNUNG.md).

## Dunning (Mahnwesen)

Overdue invoices with an open amount, and which reminder each needs next
(`server/dunning.ts`, the **Dunning** screen).

- **Derived, never stored: where an invoice stands.** Days overdue, the next
  level and from when it may go out are computed on every read from the due
  date, the payments and the notices already sent. A payment takes the
  invoice off the list with nothing to reset.
- **Stored, append-only: a notice that went out.** Level, open amount, fee,
  interest, the text and who issued it — the letter
  (`GET /api/dunning-notices/:id/pdf`) is rendered from that record and comes
  out the same on every download. One notice per level and invoice is a
  database constraint, not only an application rule.
- **Level by level.** Defaults: *Zahlungserinnerung* from 7 days after the
  due date, *1. Mahnung* from 21, *2. Mahnung* from 35, and at least 10 days
  between two notices — an invoice 60 days late gets the reminder today and
  the next level later, never three letters at once. Up to four levels, each
  with its own text and fee.
- **Fees and interest are stated, not booked.** Mahnspesen and default
  interest appear on the letter and in the notice record, but are not added
  to the invoice: they are not part of the supply (and not subject to VAT).
  The interest rate is a setting, not a constant — the statutory B2B rate
  follows the base rate (§ 456 UGB: 9.2 points above it; § 288 BGB: 9
  points) and changes twice a year. Interest is simple, per day, on the open
  amount.
- **Who may do what.** Reading is `view`; issuing one notice is `edit`; a run
  over every due invoice and the levels themselves are `manage`.
- **Delivery.** With PS-03 wired the notice is emailed to the customer's
  address; with PS-07 it is recorded on the audit trail. Without either, the
  letter is downloaded and sent by hand.

Not covered: collection agencies and court reminders (Mahnklage /
gerichtliches Mahnverfahren), booking fees or interest as receivables, and a
scheduled automatic run — PS-02 can call `POST /api/dunning/run` on a schedule.

## Partial credit notes (Teilgutschriften)

When part of a correct invoice is taken back — goods returned, a price
reduced after a complaint, a service only partly delivered — **Credit note**
on the invoice issues a document of its own (`server/credit-notes.ts`).

- **Its own number and date.** `<invoice>-GS1`, `-GS2` … per invoice, issued
  at once, never edited or deleted. The VAT is corrected in the period of
  the credit note (§ 16 UStG-AT, § 17 UStG-DE), which is where the DATEV /
  BMD export books it.
- **Never more than was invoiced, per VAT rate** — base and VAT, across all
  credit notes. A rate the invoice does not carry cannot be credited.
- **Derived effect.** Owed = gross − credited − paid, on every read: the open
  amount, the payment cap, *paid*, *overdue*, dunning, the dashboard and the
  ledger all follow. Credited in full and unpaid is *sent* with nothing open.
  A credit after full payment leaves the customer in credit (negative
  ledger balance); the refund is a bank transfer outside this module.
- **Documents.** PDF, and as e-invoice a type-381 XRechnung / ZUGFeRD or an
  ebInterface CreditMemo naming the invoice (`?credit_note=<id>`).
- **Not with a cancellation.** A cancelled invoice cannot be credited; a
  credited one cannot be cancelled — credit the rest instead.
- **Who.** Issuing is `edit`; the actor is on the document and, with PS-07,
  on the audit trail.

## Recurring invoices (wiederkehrende Rechnungen)

The same invoice every month, quarter or year (`server/recurring.ts`, the
**Recurring** screen).

- **Drafts, never issued.** A template holds a customer, lines and terms plus
  a rhythm (first period start, interval, optional last start). Generating
  turns every period that has begun into a DRAFT — dated to the period's
  first day (Leistungsdatum), with *Leistungszeitraum dd.mm.yyyy – dd.mm.yyyy*
  in its note. A person checks and sends it; numbering stays gapless.
- **At most once per period, by construction.** `recurring_runs` records
  which period produced which draft, UNIQUE (template, period). Generating
  twice, or two people at once, yields no doubles. A draft deleted by hand
  leaves its period done — it is not regenerated behind anyone's back.
- **Derived periods.** Period *n* starts *n* intervals after the start date,
  the day clamped to the month (31 Jan → 28 Feb → 31 Mar) — nothing chained,
  so nothing drifts. Which periods are due is computed on every read.
- **Bounded catch-up.** A paused template or a server that was off gets each
  missed period as its own draft, at most 24 per call.
- **Editing changes the future only.** Generated drafts are ordinary drafts.
  The start date is locked once a period is invoiced (409); a template with
  history is paused or ended, not deleted (409).
- **Who may do what.** Reading is `view`; templates and generating one are
  `edit`; *Generate all* (`POST /api/recurring/run`) is `manage` — PS-02 can
  call it on a schedule.

Not covered: usage-based lines, proration of a changed price within a
period, and sending the drafts automatically.

## Bookkeeping export: DATEV and BMD

**Exports** in the navigation turns the issued invoices of a period into the
file the tax adviser imports:

- **DATEV** — the DATEV-Format *Buchungsstapel* (EXTF 700, format version 13,
  all 125 columns, Windows-1252): one booking per invoice and VAT rate, debtor
  in Soll against the revenue account at the gross amount; a cancellation as
  the reverse booking on its own date; payments optionally against the bank
  account. The suggested accounts are the SKR03 / SKR04 automatic revenue
  accounts, so no BU key is needed.
- **BMD NTCS** — the booking import with named columns: debtor, revenue
  account, numeric document number, gross amount with the VAT opposite, the
  BMD tax code per VAT group.

Account numbers belong to the adviser's chart, not to this module. Someone
with the `manage` level enters them, together with the DATEV Beraternummer / Mandantennummer and the
BMD Steuercodes, on **Settings**. The settings start from suggestions, every
one is editable, and an export that
needs an unconfigured account refuses with the list instead of guessing.
**Run the first file through the adviser's import preview.**

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

### Billing a delivery note (MOD-17)

When an order is delivered in parts, each delivery is billed on its own:
**Bill delivery note** in the invoice list, or
`POST /api/invoices/import-delivery-note` with
`{ "delivery_note_number": "LS-2026-0001" }`. It is the same hand-over as an
offer — the same transfer shape (kind `delivery`), the same self-checking
money, a DRAFT — for exactly the quantities on that delivery note, at the
order's prices. Idempotent on the delivery note number (recorded as
`mod-17-orders-delivery:LS-…`, so it can never meet an offer number); MOD-17
is then told the delivery was billed (best-effort — the idempotency here is
what prevents a second invoice). Each route bills only its own kind: an offer
sent to the delivery route, or a delivery to the offer route, is refused.
With `ORDERS_URL` unset the endpoint answers `501`.

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

### Matched against the purchase order (MOD-06)

A bill may name the MOD-06 purchase order it is for (`po_number`) and its
**net** amount (`net_cents` — POs are priced net). With `PROCUREMENT_URL`
set, this module asks MOD-06 whether it may be paid, sending what has been
invoiced against the PO so far: this bill and the earlier ones, not
cancelled. MOD-06 compares that with what was ordered and what has arrived
(its README has the rule and the tolerance) and this module keeps every
answer, append-only.

- It asks when a bill is entered or edited, on *Check again*, and once more
  for every selected bill when a payment run is created — the last word
  before money leaves. A run refuses a bill that is **held** (its latest
  answer is anything but `matched`) or **not checked** (MOD-06 never
  answered).
- An outage of MOD-06 is recorded and decides nothing: the last real answer
  stands, so it neither pays a held bill nor holds a matched one.
- A manager may **release** a held bill with a reason (`manage`); the
  release covers the verdict it answered. An edit asks again, and a new
  held verdict needs a new release.
- Without `PROCUREMENT_URL` nothing is asked and nothing held; the PO
  number is then a reference like any other. *Mark paid* records a payment
  made elsewhere and is not held — it is a fact, not an instruction.

Pinned by `test/bill-match.test.ts` (the net amount, the cumulative
amount and that a later bill never changes an earlier verdict, unknown POs,
the run refusing and then paying, asking again before paying, the outage,
standalone, the release and its scope).

### Read from the document (PS-04)

With `AI_URL`, *Read from document* on the Bills screen takes the supplier's
invoice — an XRechnung, a ZUGFeRD PDF, an ebInterface file, a printed PDF,
or (with a model set in Settings) a scan — and fills the bill form from it.
PS-04 does the reading ([its README](../../platform/ps-04-ai-platform/README.md#document-extraction));
`server/bill-reading.ts` turns what it read into a proposal:

- **The creditor** by IBAN (the account the money goes to), else by exact
  name; neither → *Create creditor* with the name, IBAN and BIC from the
  document. A name match whose IBAN differs from the one on file is the
  classic invoice-fraud letter and says so first, before anything else.
- **The amount** is what is still to pay (EN 16931 BT-115), not the gross
  of a part-paid invoice; net, dates, the PO (BT-13) and the payment
  reference come along.
- **Twice is flagged.** The same file again (its SHA-256 is kept on the
  bill), or the same supplier number for that creditor, answers *Already
  entered as bill #n* — the unique key would refuse the save anyway, but
  a reprint with another file is caught before anyone types.
- **Our own identity goes along** (`SELLER_*` / Settings): our name, VAT ID
  and IBAN are on every invoice we receive, as the buyer's, and are never
  taken for the supplier's.
- **Nothing is saved.** The person checks, corrects and saves; the bill then
  records how it was read (`read_from`: `e-invoice:cii:pdf`, `text`,
  `model:anthropic` …) and from which document (`document_sha256`). Warnings
  from PS-04 (totals that do not add up, a failing IBAN check, a credit
  note) stand above the form.
- **Which model may read is the administrator's** (Settings → *Bills ·
  reading them from the document*, `manage`): none by default, so nothing
  leaves PS-04; a model reads scans and photos and means the invoice is
  sent to that provider.
- Without `AI_URL` the button is not shown and the form is typed as before.

Pinned by `test/bill-reading.test.ts` (the proposal and our own identity
sent along, creditor by IBAN and the changed-IBAN warning, read-from kept
and both duplicate paths, a part-paid invoice, PS-04's refusals and outage,
standalone, and the settings with their level).

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
- **A local user table, per-customer permissions** — standalone this is
  one staff admin; several people with their own levels come from PS-01
  (see [Users and access levels](#users-and-access-levels)).
- **Other currencies and VAT regimes** — EUR only; the Austrian (0/10/13/20 %)
  and German (0/7/19 %) rates. A 0 % line names its VAT category (exempt,
  reverse charge, intra-EU supply, export, zero-rated, not subject); one
  category per invoice.
- **Subscriptions beyond fixed templates** — usage-based billing, proration,
  automatic sending. Recurring drafts are the Recurring screen, quotes are
  MOD-13 Offers, reminders are the Dunning screen.
- **Corrected invoices (type 384) and refunds** — a wrong invoice is
  cancelled and reissued; part of a correct one is a partial credit note.
  Paying a customer's credit back is a bank transfer outside this module.
- **Bank reconciliation without PS-12** — standalone, payments are recorded
  manually or via the API and a payment run is marked executed by a human.
  With PS-12 Banking wired, statements come back in and are matched (see
  [Incoming payments](#incoming-payments--the-other-direction-and-equally-optional)).
  MT940 and PSP settlement files are not read.
- **UBL and PEPPOL transport** — the e-invoices are downloaded; nothing is
  sent over PEPPOL, and the UBL syntax is not written. Incoming e-invoices are
  not read on the bills side. See [`docs/E-RECHNUNG.md`](../../docs/E-RECHNUNG.md).
- **Bank transport other than EBICS** — standalone the module produces the
  file and stops there; PS-12 Banking sends it over EBICS. See
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

## Users and access levels

Standalone, this module has one login — the local admin — and it manages
everything. With PS-01 Identity wired (`IDENTITY_URL` + `IDENTITY_ORG`), every
person signs in as themselves and gets the level PS-01 grants them here:

| PS-01 permission | Level | May |
| --- | --- | --- |
| `module:invoice-billing:view` | `view` | read everything, change nothing |
| `module:invoice-billing:edit` | `edit` | the day-to-day work: create, update, delete |
| `module:invoice-billing:manage` or `platform:admin` | `manage` | also what `server/access.ts` reserves |

`module:*:<level>` grants a level in every module. Reads need `view`, any other
method needs `edit`. Beyond the method default, [`server/access.ts`](./server/access.ts) names: `POST /api/payment-runs` → `manage`; `POST /api/payment-runs/:id/submit` → `manage`; `POST /api/payment-runs/:id/mark-executed` → `manage`; `POST /api/payment-runs/:id/discard` → `manage`; `PUT /api/settings/seller` → `manage`; `PUT /api/accounting-settings` → `manage`; `POST /api/bills/:id/release-match` → `manage`. A refused request answers **403**
`{ error, required, access }`; `GET /api/me` reports the caller's `access`.
Setting `IDENTITY_PERMISSION` restores the old rule (one permission, which
manages). The contract is in [`docs/ACCESS-LEVELS.md`](../../docs/ACCESS-LEVELS.md).

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
