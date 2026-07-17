# MOD-03 · Inventory Management

Stock levels, SKUs, warehouse locations, and purchase order tracking in
one place. Part of the [0815software](https://0815software.com) module
catalogue — standard business software, MIT-licensed, always free.

The core correctness property: **stock levels are never stored, they are
derived**. Every change to inventory — goods in, transfers, stocktake
corrections, PO receipts — is an entry in an append-only movements
ledger, and the current level of any product in any warehouse is simply
the sum of its movements. There is no mutable stock counter that can
drift out of sync, and the test suite proves it.

## Stack

Deliberately standard and boring (same as MOD-01 and MOD-02):

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Styling  | Hand-rolled CSS, no framework                 |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-03-inventory-management
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3003
npm run dev:api

# terminal 2 — UI on :5193 (proxies /api to :3003)
npm run dev:web
```

Open http://localhost:5193 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3003
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Data model

Six tables, one invariant:

```
warehouses            code, name                       (seeded, a few locations)
products              sku, name, unit, reorder_point   (CRUD via UI/API)
suppliers             name, email                      (seeded, simple lookup)
movements             product, warehouse, type, signed qty, reference, note, timestamp
purchase_orders       po_number, supplier, status, created_at
purchase_order_lines  po, product, qty_ordered, qty_received
```

**The ledger.** `movements` is append-only. Quantities are signed and
each entry has one of five types:

| Type           | Sign | Meaning                                          |
| -------------- | ---- | ------------------------------------------------ |
| `receipt`      | +    | Goods in outside a PO (returns, found stock)     |
| `transfer_out` | −    | One leg of an inter-warehouse transfer           |
| `transfer_in`  | +    | The other leg — written in the same transaction  |
| `adjustment`   | ±    | Stocktake correction — **note required**         |
| `po_receipt`   | +    | Goods received against a purchase order line     |

Current stock per (product, warehouse) = `SUM(quantity)` over that pair's
movements. Transfers conserve total stock by construction (two legs that
sum to zero, one SQLite transaction, rejected with 422 if the source
warehouse doesn't hold enough). Adjustments that would push a level below
zero are rejected. The only mutable quantity anywhere is
`purchase_order_lines.qty_received` — PO *progress*, not stock — and it
is only ever updated in the same transaction that appends the matching
`po_receipt` movements.

**Purchase orders** flow `draft → ordered → partially_received →
received`. Receiving takes a target warehouse and per-line quantities;
partial receipts are fine, over-receipt (beyond `qty_ordered`) rejects
the whole request with 422, and the status is recomputed from the lines
after every receipt. Drafts can be deleted; ordered POs are history and
cannot.

## Features

- **Stock overview** — one row per product, one column per warehouse,
  totals, search on SKU/name, low-stock filter (total ≤ reorder point,
  highlighted), CSV export of exactly the filtered view.
- **Products** — CRUD with validation (SKU format + uniqueness); delete
  is refused (409) once a product has ledger history. Per-product
  movement history with type, warehouse, signed quantity, reference and
  note.
- **Movements** — record receipts and adjustments from the UI; transfer
  stock between warehouses with an auto-generated `TRF-…` reference
  linking both legs.
- **Purchase orders** — create drafts (supplier + lines), mark ordered,
  receive fully or partially into any warehouse, with live status
  tracking.
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, optional Secure), exactly as
  in MOD-02.

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                | Purpose                                  |
| ------------------- | ---------------------- | ---------------------------------------- |
| `PORT`              | `3003`                 | API / production server port             |
| `DATABASE_PATH`     | `./data.db`            | SQLite file (created on demand)          |
| `ADMIN_USERNAME`    | `admin`                | Login user                               |
| `ADMIN_PASSWORD`    | `admin`                | Login password — **change in prod**      |
| `SESSION_SECRET`    | `dev-secret-change-me` | HMAC key for the session cookie          |
| `SESSION_TTL_HOURS` | `12`                   | Session lifetime                         |
| `COOKIE_SECURE`     | `false`                | Set `true` behind HTTPS                  |

The server prints a warning on startup while the default password is in
use. The dev server does not load `.env` files by itself — export the
variables in your shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except for
`POST /api/login` and `GET /api/health`.

```
POST   /api/login                        {username, password} → session cookie
POST   /api/logout
GET    /api/me
GET    /api/warehouses
GET    /api/suppliers

GET    /api/stock                        ?search=&low=1 → levels per warehouse + total
GET    /api/stock/export.csv             same filters, RFC-4180 CSV download

GET    /api/products
POST   /api/products                     {sku, name, unit, reorder_point}
GET    /api/products/:id                 product + per-warehouse levels
PUT    /api/products/:id
DELETE /api/products/:id                 409 if the product has ledger history
GET    /api/products/:id/movements       full history, newest first

POST   /api/movements                    {type: receipt|adjustment, product_id,
                                          warehouse_id, quantity, reference?, note?}
                                         (adjustment: note required, may be negative)
POST   /api/transfers                    {product_id, from_warehouse_id,
                                          to_warehouse_id, quantity, reference?, note?}

GET    /api/purchase-orders
POST   /api/purchase-orders              {supplier_id, lines: [{product_id, quantity}]}
GET    /api/purchase-orders/:id
POST   /api/purchase-orders/:id/order    draft → ordered
POST   /api/purchase-orders/:id/receive  {warehouse_id, lines: [{line_id, quantity}]}
DELETE /api/purchase-orders/:id          drafts only (otherwise 409)
```

Validation failures return `422` with `{error, details: [{field,
message}]}`; state conflicts (receiving a draft, deleting an ordered PO)
return `409`.

## Scripts

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` proxy                       |
| `npm run seed`    | Create/seed the SQLite database (skips non-empty DBs)   |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | Ledger-invariant + API tests (Vitest, in-memory SQLite) |

The tests prove the properties that matter: every reported level equals
the SQL sum of its movements, transfers conserve totals and reject
insufficient stock atomically, PO receiving drives status and stock
correctly, over-receipt and note-less adjustments are 422s, and every
endpoint is 401 without a session.

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`) and `COOKIE_SECURE=true`, and terminate TLS in
  front (Caddy/nginx).
- Not a fit for serverless platforms: SQLite wants a persistent filesystem.

## Out of scope

Kept out deliberately to stay a 4–5 week module. If you need any of
these, that's commissioned work — exactly the kind 0815software does:

- **Multi-user accounts and roles** — this ships a single staff admin by
  design (same auth pattern as MOD-02). No per-user audit trail.
- **Warehouse/supplier management UI** — both are simple seeded tables;
  edit them in SQLite or extend the seed.
- **Sales-side stock reservation** — no allocations, backorders or
  pick/pack flows; the ledger tracks physical stock only.
- **Bin/shelf locations within a warehouse** — granularity is the
  warehouse, not the rack.
- **Costing and valuation** — no purchase prices, FIFO/moving average or
  stock value reports.
- **Barcode scanning, label printing, ERP/webshop integrations** — the
  clean REST API is the integration point.

## License

MIT © 0815software — see [LICENSE](LICENSE).
