# MOD-06 · Procurement Tracker

RFQ, purchase orders, multi-tier approval workflows. Export to any ERP
CSV format. Part of the [0815software](https://0815software.com) module
catalogue — standard business software, MIT-licensed, always free.

Three correctness properties are the point of this module, and the test
suite proves each of them:

1. **Approval tiers are derived from the total — and frozen at submit.**
   The threshold brackets live in ONE server config file
   ([`server/approval-config.ts`](server/approval-config.ts)). Submitting
   a PO computes its required tiers from its total and writes an
   immutable snapshot (total + tiers); approvals must then be recorded
   strictly in tier order (tier 2 before tier 1 → 422), and only a fully
   approved PO can be marked ordered (anything pending → 422).
2. **Approval history is append-only** (MOD-03's ledger philosophy).
   Approval rows are never updated or deleted. A rejection — or a manual
   return-to-draft — puts the PO back into `draft`, which makes the
   current submission's approvals *void by derivation*; every row stays
   in the timeline forever, labelled VOIDED. Re-submitting starts a
   fresh submission and every tier approves again.
3. **Frozen means frozen.** Any edit to a submitted or partially
   approved PO's lines is a 409 — the lines are exactly what the
   approvers saw. Send it back to draft first (voiding the approvals),
   then edit. RFQ lines freeze the same way once the first quote
   arrives, and awarding copies the winning quote 1:1 into a draft PO
   inside one transaction.

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-05):

| Layer    | Choice                                      |
| -------- | ------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)       |
| API      | Node + Express 5                            |
| Storage  | better-sqlite3 (single file, zero services) |
| Styling  | Hand-rolled CSS, no framework               |
| Tests    | Vitest + Supertest                          |

Runtime dependencies: `express`, `better-sqlite3`, `react`,
`react-dom`. That's all — no CDN, no external services.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-06-procurement-tracker
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3006
npm run dev:api

# terminal 2 — UI on :5196 (proxies /api to :3006)
npm run dev:web
```

Open http://localhost:5196 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3006
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Data model

Ten tables, no stored derived state:

```
suppliers        name, contact, email, notes                  (CRUD via UI/API)
rfqs             title, status (open|awarded|closed), due date,
                 award audit trail (winner, PO, timestamp)
rfq_lines        rfq, position, description, quantity, unit   (no prices!)
rfq_invitations  rfq × supplier (unique)
quotes           rfq × supplier (unique), valid_until, note
quote_lines      quote × rfq_line → unit_price_cents
purchase_orders  number, supplier, optional source rfq,
                 status (draft|submitted|ordered|closed), submission_no
po_lines         po, position, description, quantity, unit,
                 unit_price_cents
po_submissions   APPEND-ONLY: po × submission_no → frozen total_cents
                 + required_tiers, one row per submit
approvals        APPEND-ONLY: po, submission_no, tier, decision
                 (approved|rejected), approver, note, timestamp
po_counters      year → last_seq                              (PO number source)
```

**Money** is integer cents everywhere (MOD-04's discipline); euros exist
only at the rendering edge. Prices are **net** — procurement has no VAT
handling (out of scope, see below). A PO's total is derived as
`sum(round(quantity × unit_price_cents))` per line by one shared
function (`shared/money.ts`) used by the server, the client preview and
the tests, so they can never disagree. The only persisted total is the
frozen `po_submissions` snapshot — the number the approval tiers were
derived from.

**Derived statuses** never hit a column:

- RFQ `quoted` = stored `open` + at least one quote received.
- PO `approved` = stored `submitted` + every frozen required tier has an
  active approval.
- An approval row is `voided` when its submission is no longer the
  active one (superseded by re-submit, or the PO went back to draft).

## Lifecycles

```
RFQ:  open ──first quote──▶ quoted (derived) ──award──▶ awarded ──▶ (draft PO)
        │                                     └────────close───▶ closed (no award)
PO:   draft ──submit──▶ submitted ──all tiers──▶ approved (derived)
        ▲                  │                        │
        │            reject at any tier        mark ordered
        └──────────────────┘                        ▼
        └────return-to-draft────┘             ordered ──close──▶ closed
```

- RFQ lines are editable while open and unquoted; the first quote
  freezes them (409). Awarding requires a recorded quote (422 without
  one) and is terminal — a second award is a 409. Close-without-award is
  the other terminal state.
- A quote must price **every** RFQ line (422 otherwise) and only invited
  suppliers can quote (422). Quotes can be replaced while the RFQ is
  open.
- PO numbers (`PO-2026-0001`, per-year sequence) are assigned at
  creation and survive every submit/reject cycle.
- Deleting is only possible where nothing is lost: open RFQs without
  quotes, and draft POs that were never submitted (and weren't created
  by an award). Everything else is a 409 — history is append-only.

## Approval rules — one config file

[`server/approval-config.ts`](server/approval-config.ts) is the single
source of truth. The defaults:

| PO total (net)         | Required tiers                              |
| ---------------------- | ------------------------------------------- |
| ≤ €1,000.00            | 1 (Team lead)                               |
| ≤ €10,000.00           | 1 + 2 (Department head)                     |
| above                  | 1 + 2 + 3 (Finance)                         |

Bounds are **inclusive**: a PO of exactly €1,000.00 needs tier 1 only;
€1,000.01 needs tiers 1+2. The tests pin these boundaries.

Change the workflow by editing that file (labels, thresholds, more
tiers, more brackets); a self-check at startup rejects malformed
configs. The UI renders the rules fetched from `GET /api/config` — it
never duplicates the thresholds. Because each submission freezes its
own tier list, config changes never affect POs already in approval.

**Approver names are free text.** There is no user management (single
staff admin, like every 0815 module) — the approver field records *who*
decided as a name, the way a paper signature line would. If you need
enforced identities, that's the multi-user extension listed under out
of scope.

## ERP CSV export — "any format" kept honest

Export mappings are declarative profiles in ONE config file,
[`server/export-profiles.ts`](server/export-profiles.ts): a profile is
a name, a delimiter and a column list — each column a header label, a
field path from the documented set, and an optional money/date format.
The render engine (`server/csv.ts`) never changes.

The export covers POs with status **ordered** (fully approved and sent
to the supplier, not yet closed), one CSV row per PO line, RFC-4180
quoting, CRLF line endings. Close a PO after importing it into your ERP
to drop it from the next export.

Field paths: `po.number`, `po.supplier_name`, `po.supplier_email`,
`po.supplier_contact`, `po.currency` (always `EUR`), `po.note`,
`po.total_cents`, `po.created_at`, `po.ordered_at`, `line.position`,
`line.description`, `line.quantity`, `line.unit`,
`line.unit_price_cents`, `line.net_cents`.
Money formats: `cents` (123456), `decimal-dot` (1234.56),
`decimal-comma` (1234,56). Date formats: `iso` (2026-07-18), `dmy-dot`
(18.07.2026), `ymd-compact` (20260718).

Three **example** profiles ship out of the box — conventions modelled on
the respective ecosystems, *not certified import formats*:

| Profile        | Flavour                                                        |
| -------------- | -------------------------------------------------------------- |
| `GENERIC`      | snake_case headers, ISO dates, dot-decimal euros, `,`          |
| `SAP-B1-STYLE` | DocNum/CardName/… headers, compact `YYYYMMDD` dates, `,`       |
| `DATEV-STYLE`  | German headers, `DD.MM.YYYY` dates, comma decimals, `;`        |

**Adding your ERP's format** is one config entry — no code:

```ts
// server/export-profiles.ts — append to EXPORT_PROFILES:
{
  name: 'MY-ERP',
  description: 'Our Navision import layout.',
  delimiter: ';',
  columns: [
    { header: 'OrderNo',  field: 'po.number' },
    { header: 'Vendor',   field: 'po.supplier_name' },
    { header: 'Date',     field: 'po.ordered_at', date: 'dmy-dot' },
    { header: 'Item',     field: 'line.description' },
    { header: 'Qty',      field: 'line.quantity' },
    { header: 'Amount',   field: 'line.net_cents', money: 'decimal-comma' },
  ],
},
```

Restart, and `MY-ERP` appears in `GET /api/config`, on the export page
and at `GET /api/export/pos.csv?profile=MY-ERP`. The startup self-check
rejects unknown field paths or format/field mismatches.

## Features

- **Suppliers** — CRUD with validation; deletion refused (409) once a
  supplier is referenced by RFQs or POs.
- **RFQ list/detail** — invite suppliers, enter/replace quotes, quotes
  side-by-side per line with derived totals and the cheapest column
  highlighted, one-click award (→ draft PO), close without award.
- **PO list** — search, status filter (including derived `approved`),
  tier-dot approval progress per row.
- **PO detail** — line items, frozen-tier summary, approve/reject with
  approver name + note at the pending tier, submit / return-to-draft /
  mark-ordered / close according to state, and the full append-only
  timeline: every submission snapshot and every decision, voided rows
  labelled.
- **PO editor** — drafts only; live total and the approval bracket it
  falls into, rendered from the server config.
- **Export page** — profile cards (columns, delimiter, description) with
  CSV download, count and volume of ordered POs.
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (`mod06_session`, HttpOnly, SameSite=Lax, optional
  Secure), exactly as in MOD-02 … MOD-05.

## Configuration

All runtime settings via environment variables (see
[`.env.example`](.env.example)):

| Variable            | Default                | Purpose                             |
| ------------------- | ---------------------- | ----------------------------------- |
| `PORT`              | `3006`                 | API / production server port        |
| `DATABASE_PATH`     | `./data.db`            | SQLite file (created on demand)     |
| `ADMIN_USERNAME`    | `admin`                | Login user                          |
| `ADMIN_PASSWORD`    | `admin`                | Login password — **change in prod** |
| `SESSION_SECRET`    | `dev-secret-change-me` | HMAC key for the session cookie     |
| `SESSION_TTL_HOURS` | `12`                   | Session lifetime                    |
| `COOKIE_SECURE`     | `false`                | Set `true` behind HTTPS             |

Approval tiers and export profiles are deliberately *code* config
(`server/approval-config.ts`, `server/export-profiles.ts`), not env
vars — they are structured data with startup validation. The server
prints a warning while the default password is in use. The dev server
does not load `.env` files by itself — export the variables in your
shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except
for `POST /api/login` and `GET /api/health`. Money in/out is integer
cents.

```
POST   /api/login                        {username, password} → session cookie
GET    /api/auth-mode                    local or SSO — which credentials to name
POST   /api/logout
GET    /api/me
GET    /api/config                       tier labels, threshold rules, export profiles

GET    /api/suppliers                    ?search= → suppliers + rfq/po counts
POST   /api/suppliers                    {name, contact?, email?, notes?}
GET    /api/suppliers/:id
PUT    /api/suppliers/:id
DELETE /api/suppliers/:id                409 if referenced by RFQs/POs

GET    /api/rfqs                         ?search=&status= (open|quoted|awarded|closed)
POST   /api/rfqs                         {title, due_date?, note?,
                                          lines: [{description, quantity, unit?}]}
GET    /api/rfqs/:id                     lines, invitations, quotes w/ derived totals
PUT    /api/rfqs/:id                     open + unquoted only — else 409
DELETE /api/rfqs/:id                     open + unquoted only — else 409
POST   /api/rfqs/:id/invitations         {supplier_id} — duplicate → 409
PUT    /api/rfqs/:id/quotes/:supplierId  {valid_until?, note?, prices: [{rfq_line_id,
                                          unit_price_cents}]} — must cover every
                                          line (422); uninvited supplier → 422
POST   /api/rfqs/:id/award               {supplier_id} → {rfq, po (draft, copied)}
                                          no quote → 422; already awarded → 409
POST   /api/rfqs/:id/close               close without award — terminal

GET    /api/pos                          ?search=&status= (draft|submitted|approved|
                                          ordered|closed — approved is derived)
POST   /api/pos                          {supplier_id, note?, lines: [{description,
                                          quantity, unit?, unit_price_cents}]}
GET    /api/pos/:id                      lines, frozen tiers, submissions, timeline
PUT    /api/pos/:id                      drafts only — submitted/approved/ordered → 409
DELETE /api/pos/:id                      never-submitted, non-award drafts only → 409
POST   /api/pos/:id/submit               freezes total + required tiers (config)
POST   /api/pos/:id/return-to-draft      voids approvals (history kept)
POST   /api/pos/:id/approvals            {tier, approver, note?} — out of order → 422,
                                          tier not required → 422, duplicate → 409
POST   /api/pos/:id/reject               {tier, approver, note?} → back to draft,
                                          approvals voided, history kept
POST   /api/pos/:id/mark-ordered         fully approved only — pending tiers → 422
POST   /api/pos/:id/close                ordered only

GET    /api/export/profiles              the shipped profiles
GET    /api/export/pos.csv?profile=NAME  ordered POs through a profile (CSV download)
```

Validation failures return `422` with `{error, details: [{field,
message}]}`; state conflicts (editing frozen POs, double award,
duplicate approval, deleting history) return `409`.

## Scripts

| Script            | What it does                                           |
| ----------------- | ------------------------------------------------------ |
| `npm run dev:api` | API with reload (tsx watch)                            |
| `npm run dev:web` | Vite dev server with `/api` proxy                      |
| `npm run seed`    | Create/seed the SQLite database (skips non-empty DBs)  |
| `npm run build`   | Type-check (client + server) and build both to `dist/` |
| `npm start`       | Run the production server (serves API + built client)  |
| `npm test`        | Invariant + API tests (Vitest, in-memory SQLite)       |

The tests prove the properties that matter: required tiers at every
threshold boundary (including exactly-at), out-of-order approval 422,
rejection returning to draft with voided-but-retained history, frozen
submitted POs (409), ordered blocked until fully approved (422), award
copying the winning quote 1:1 into a draft PO, double-award 409,
uninvited/incomplete quotes 422, exact headers and money/date
formatting for all three export profiles, and 401 everywhere without a
session.

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for
  `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`), `COOKIE_SECURE=true`, and terminate TLS in
  front (Caddy/nginx).
- Not a fit for serverless platforms: SQLite wants a persistent
  filesystem.

## Out of scope

Kept out deliberately to stay a 4–6 week module. If you need any of
these, that's commissioned work — exactly the kind 0815software does:

- **User management, roles, per-tier permissions** — one staff admin by
  design (same auth pattern as MOD-02 … MOD-05). Approver names are
  free-text signature lines, not enforced identities; nothing stops the
  admin recording any name at any tier.
- **Emailing RFQs or POs to suppliers** — inviting records intent,
  quotes are entered by your staff. No SMTP, no supplier portal; this
  module has zero external services.
- **VAT and other currencies** — net EUR prices only. Procurement
  compares and approves net; tax lives in your ERP.
- **Goods receipt & three-way match** — "closed" is a manual archive
  step. Receiving against POs exists in MOD-03 (Inventory Management);
  invoice matching would tie in MOD-04.
- **Budgets, cost centers, projects** — the note field is free text; no
  ledger dimensions.
- **Delegation, vacation rules, parallel approvals** — tiers approve
  strictly in sequence; anything fancier (either/or approvers,
  amount-scoped delegates) is an extension of the same frozen-snapshot
  model.
- **Certified ERP integrations** — the shipped profiles are examples in
  the spirit of their namesakes, not validated import formats. Live
  API/IDoc/OData integrations are commissioned work.

## License

MIT © 0815software — see [LICENSE](LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records key
state changes on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the
shared [`@0815software/platform-clients`](../../platform/clients) package
(it can also send via PS-03 when `NOTIFICATION_URL` is set). Best-effort and
opt-in — unset, the module runs standalone. See `server/platform.ts`.

With `CUSTOMERS_URL` set, a supplier created here is registered with
[PS-11 Customers](../../platform/ps-11-customers) as a **`supplier`** party, and
the master `party_id` is stored on the local row. Suppliers and customers never
match each other there, so a company you both buy from and sell to stays two
relationships with two sets of terms — a procurement import can never rewrite a
customer's billing address. Unset, the local `suppliers` table is the only record.
