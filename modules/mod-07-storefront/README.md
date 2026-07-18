# MOD-07 · Storefront

Product catalogue, cart, checkout, and order management. No SaaS fees,
no revenue cut. Part of the [0815software](https://0815software.com)
module catalogue — standard business software, MIT-licensed, always
free.

One app, two faces on one port: the **public shop** (no login, no
accounts — an anonymous signed cart cookie and a signed order-lookup
link are all the identity a guest ever needs) and the **admin** (single
staff login: products, categories, orders).

Four correctness properties are the point of this module, and the test
suite proves each of them:

1. **Prices are snapshotted into order lines at checkout.** An order
   line copies sku, name, gross unit price and VAT rate out of the
   catalogue in the checkout transaction — a later price change never
   alters an existing order.
2. **No overselling — checkout is atomic.** One SQLite transaction
   validates every cart line against current stock and decrements it.
   If ANY line cannot be fulfilled, the whole checkout fails with a 422
   listing every offending item and nothing is decremented. A database
   CHECK (`stock >= 0`) is the backstop underneath. Cancelling an
   unshipped order restores stock exactly; cancelling a shipped one is
   a 409.
3. **Totals are never stored, they are derived.** Net, VAT-per-rate and
   gross are always recomputed from the order lines by one shared money
   function used by the API, the cart preview and the CSV export — so
   they cannot drift.
4. **Guest lookup is capability-based.** The order confirmation hands
   out a signed token once; the status endpoint answers only to
   `ref + valid token`, and a wrong or missing token is the same 404 as
   an unknown ref — refs leak nothing.

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-06):

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Styling  | Hand-rolled CSS, no framework                 |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`,
`react-dom`. That's all — no payment SDK, no CDN, no external services.

**Product images:** none, deliberately — no binary files in this
repository. Every product renders a generated inline-SVG placeholder
(monogram initials on the product's optional `accent` color) via
`src/components/ProductMark.tsx`. That component is the one standard
place to plug in real images: swap the SVG for an `<img>`, and add an
image URL/path column next to `accent` in `products`.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-07-storefront
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3007
npm run dev:api

# terminal 2 — UI on :5197 (proxies /api to :3007)
npm run dev:web
```

Open http://localhost:5197 for the shop; the admin lives at
http://localhost:5197/admin (local-dev default credentials
**admin / admin**).

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3007
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Data model

Seven tables, no stored derived state:

```
categories      name, position
products        sku, name, description, unit_price_cents (GROSS,
                VAT included), vat_rate (0|10|20), stock, category,
                accent (placeholder color), archived flag
carts           anonymous server-side carts (signed cookie holds the id)
cart_lines      cart × product → quantity           (live prices, never snapshotted)
orders          ref (ORD-<year>-<seq>, gapless), status, customer name,
                email, shipping address, paid_at, cancelled_at
order_lines     SNAPSHOT: product, sku, name, quantity,
                unit_price_cents, vat_rate — frozen at checkout
order_events    append-only status history (placed, confirmed, …)
order_counters  year → last_seq                     (the ref source)
```

**Money** is integer cents everywhere; euros exist only at the
rendering edge. Because this is a consumer shop, the stored price is
the **gross sticker price** (VAT included) and VAT is *extracted* per
rate — the Austrian/German B2C convention:

- line gross = `quantity × unit_price_cents` (integers — exact),
- per rate: net = `round(gross base × 100 / (100 + rate))`,
  VAT = gross base − net — computed once per rate on the tax base,
- order: gross = Σ gross bases, VAT = Σ VAT, net = gross − VAT.

**Derived, never stored:** order totals and the VAT breakdown (from the
snapshot lines), payment status (from `paid_at`), cart totals and item
counts (from the live catalogue).

## Checkout rules

- The cart is server-side; the browser holds only a signed cart id in
  the `mod07_cart` cookie (HttpOnly, HMAC-signed — a tampered cookie is
  simply "no cart").
- Cart operations validate against **live** stock: adding or updating
  beyond availability is a 422 that names the available quantity.
  Carts always show current prices — nothing is locked until checkout.
- Checkout (name, email, shipping address — no account) runs as ONE
  transaction: re-validate every line against current stock (any
  shortage → 422 listing all offending items, nothing decremented),
  decrement stock, draw the next gapless `ORD-<year>-<seq>` ref,
  snapshot the lines, append the `placed` event, delete the cart.
- **Payment is out of scope** (zero external services). Orders are
  placed with status `placed` and payment status `unpaid`. Where a PSP
  would hook in:
  - client: `CheckoutView` currently posts straight to
    `/api/shop/checkout` — a PSP redirect/element goes before that call;
  - server: `POST /api/shop/checkout` is where you'd create the PSP
    session, and the PSP's success webhook would call the same domain
    function as `POST /api/admin/orders/:id/mark-paid` (`markPaid` in
    `server/store.ts`).
- The confirmation page shows the order ref plus a signed lookup link
  (`/order/<ref>?token=…`) — the guest's only key to the order. The
  admin marks payment manually until a PSP exists.

## Order lifecycle

```
placed ──▶ confirmed ──▶ shipped ──▶ delivered
   │            │
   └────────────┴── cancel (restores stock) ──▶ cancelled
```

- Transitions are strictly one step forward; skipping (delivered before
  shipped) or moving backwards is a 422.
- Cancelling is allowed while `placed` or `confirmed` and restores the
  stock in the same transaction; cancelling `shipped`/`delivered` is a
  409 (the goods left the building — returns are out of scope).
- `mark-paid` records `paid_at` once (again → 409; cancelled → 409).
- Every transition appends to `order_events` — the history is
  append-only and shown to both admin and guest.

## Features

- **Shop** — catalogue with category filter chips and search, product
  detail with stock display, cart with live availability warnings,
  checkout form, confirmation with the signed status link, guest order
  status page (items, totals, status history).
- **Admin · Orders** — list with status/payment filters and search,
  CSV export (respects the active filters), detail with snapshot lines,
  VAT breakdown, shipping address, status history; one-click next-step
  transition, mark-paid, cancel + restock.
- **Admin · Products** — CRUD with validation (unique SKU, gross price,
  VAT rate, accent color), relative stock adjustments (never below
  zero), archive flag (hidden from the shop, old orders intact);
  deleting a product referenced by orders is a 409.
- **Admin · Categories** — CRUD with position ordering; deleting a
  non-empty category is a 409.
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie `mod07_session` (HttpOnly, SameSite=Lax, optional
  Secure), exactly as in MOD-02…06. All `/api/admin/*` routes except
  login answer 401 without it.

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                | Purpose                                  |
| ------------------- | ---------------------- | ---------------------------------------- |
| `PORT`              | `3007`                 | API / production server port             |
| `DATABASE_PATH`     | `./data.db`            | SQLite file (created on demand)          |
| `ADMIN_USERNAME`    | `admin`                | Admin login user                         |
| `ADMIN_PASSWORD`    | `admin`                | Admin login password — **change in prod**|
| `SESSION_SECRET`    | `dev-secret-change-me` | HMAC key for session cookie, cart cookie AND order-lookup tokens |
| `SESSION_TTL_HOURS` | `12`                   | Admin session lifetime                   |
| `COOKIE_SECURE`     | `false`                | Set `true` behind HTTPS                  |

Rotating `SESSION_SECRET` invalidates admin sessions, guest carts and
every order-lookup link already handed out. The server prints a warning
on startup while the default password is in use. The dev server does
not load `.env` files by itself — export the variables in your shell or
use `node --env-file`.

## API

JSON in/out, money is integer cents. Two route groups:

**Public (`/api/shop`, no auth):**

```
GET    /api/health
GET    /api/shop/categories                 with per-category product counts
GET    /api/shop/products                   ?category=<id>&search=
GET    /api/shop/products/:id               404 for unknown or archived
GET    /api/shop/cart                       live prices + availability + derived totals
POST   /api/shop/cart/items                 {product_id, quantity} — creates the cart
                                            and sets the signed mod07_cart cookie;
                                            over-stock → 422 with items[{available}]
PUT    /api/shop/cart/items/:productId      {quantity} (0 removes) — over-stock → 422
DELETE /api/shop/cart/items/:productId
POST   /api/shop/checkout                   {name, email, address}
                                            → 201 {ref, token, order}; any shortage →
                                            422 with ALL offending items, nothing changed
GET    /api/shop/orders/:ref?token=…        guest status; wrong/missing token → 404
```

**Admin (`/api/admin`, session cookie required except login):**

```
POST   /api/admin/login                     {username, password} → mod07_session cookie
POST   /api/admin/logout
GET    /api/admin/me

GET    /api/admin/categories
POST   /api/admin/categories                {name, position?}
PUT    /api/admin/categories/:id
DELETE /api/admin/categories/:id            409 if it has products

GET    /api/admin/products                  ?search=&category=
POST   /api/admin/products                  {sku, name, description?, unit_price_cents,
                                             vat_rate, stock?, category_id, accent?,
                                             archived?}
GET    /api/admin/products/:id
PUT    /api/admin/products/:id
POST   /api/admin/products/:id/stock        {delta} — relative; below zero → 422
DELETE /api/admin/products/:id              409 if referenced by order lines

GET    /api/admin/orders                    ?status=&payment=&search=
GET    /api/admin/orders/export.csv         same filters, RFC-4180, derived totals
GET    /api/admin/orders/:id                snapshot lines, VAT breakdown, events
POST   /api/admin/orders/:id/status         {status} — next step only, skip → 422
POST   /api/admin/orders/:id/cancel         restores stock; shipped/delivered → 409
POST   /api/admin/orders/:id/mark-paid      once; again or cancelled → 409
```

Validation failures return `422` with `{error, details: [{field,
message}]}`; stock shortages additionally carry `items: [{product_id,
sku, name, requested, available}]`; state conflicts return `409`.

## Scripts

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` proxy                       |
| `npm run seed`    | Create/seed the SQLite database (skips non-empty DBs)   |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | Invariant + API tests (Vitest, in-memory SQLite)        |

The tests prove the properties that matter: price-snapshot invariance
(reprice after checkout, order unchanged), atomic no-oversell
(multi-line partial failure leaves stock and orders untouched), stock
restore on cancel + 409 on cancelling shipped, mixed-VAT totals and
rounding against the one shared money function, guest lookup with a
valid token vs. indistinguishable 404s for wrong/missing tokens, cart
stock validation (incl. cumulative adds and tampered cookies), strict
one-step status transitions (delivered before shipped → 422), and 401
on every admin route without a session.

## Deploy notes

The shop face is *public* — put the whole app behind TLS.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for
  `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`) and `COOKIE_SECURE=true`, and terminate TLS
  in front (Caddy/nginx). The admin is only protected by that login —
  consider additionally restricting `/api/admin` and `/admin` by IP or
  VPN at the proxy.
- Not a fit for serverless platforms: SQLite wants a persistent
  filesystem.

## Out of scope

Kept out deliberately to stay a 5–6 week module. If you need any of
these, that's commissioned work — exactly the kind 0815software does:

- **Payment integration** — no PSP, no card fields, no webhooks. Orders
  are placed `unpaid`; the hook points are documented above. This is
  the first thing a real deployment adds.
- **Customer accounts** — guests are identified by the signed cart
  cookie and order-lookup link only. Accounts, order history and saved
  addresses are MOD-01 territory.
- **Emails** — no order confirmation or shipping notification mails;
  the confirmation page with the status link is the receipt. Zero
  external services.
- **Shipping logic** — no carriers, rates, weights or tracking numbers;
  shipping is a free-text address and a status. Flat fees could be a
  0%-VAT product; real rate logic is an extension.
- **Returns / refunds / partial shipments** — cancellation of unshipped
  orders only. Anything after "shipped" is a manual process.
- **Discounts, vouchers, tax zones, multi-currency** — EUR only,
  Austrian VAT rates (0/10/20), one price per product.
- **Multi-warehouse stock** — one integer per product. Real inventory
  across locations is MOD-03.
- **SEO / SSR** — the shop is a client-rendered SPA served by Express.
  Pre-rendering is out of scope.

## License

MIT © 0815software — see [LICENSE](LICENSE).
