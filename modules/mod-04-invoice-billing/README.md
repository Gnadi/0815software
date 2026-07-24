# MOD-04 · Invoice & Billing

Generate, send, and track invoices. PDF export, payment status, customer
ledger. Part of the [0815software](https://0815software.com) module
catalogue — standard business software, MIT-licensed, always free.

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

Five tables, no stored derived state:

```
customers         name, email, vat_id, address              (CRUD via UI/API)
invoices          number (NULL for drafts), customer, status,
                  issue_date, due_date, payment_terms_days,
                  note, cancellation audit trail
invoice_lines     invoice, position, description, quantity,
                  unit_price_cents, vat_rate (0 | 10 | 20)
payments          invoice, date, amount_cents, note
invoice_counters  year → last_seq                           (the number source)
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
| `SELLER_IBAN`       | *(example IBAN)*       | PDF footer: bank account                 |
| `SELLER_BIC`        | `EXAMPLEX`             | PDF footer: BIC                          |

The server prints a warning on startup while the default password is in
use. The dev server does not load `.env` files by itself — export the
variables in your shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except for
`POST /api/login` and `GET /api/health`. Money in/out is integer cents.

```
POST   /api/login                      {username, password} → session cookie
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
and 401 everywhere without a session.

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

Every call is best-effort — a downstream outage is logged and never fails the
invoice — and entirely opt-in: with the URLs unset (`NOTIFICATION_URL`,
`FILES_URL`, `AUDIT_URL`, `PLATFORM_SERVICE_TOKEN`) the module behaves exactly
as before, standalone, with no outbound calls. See `server/platform.ts`.

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
- **e-Invoicing formats** (ebInterface, XRechnung, ZUGFeRD/Factur-X) —
  the PDF is a plain human-readable document.

## License

MIT © 0815software — see [LICENSE](LICENSE).
