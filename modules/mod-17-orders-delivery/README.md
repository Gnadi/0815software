# MOD-17 · Orders & Delivery Notes

The step between the accepted offer and the invoice. An order is confirmed —
from an accepted MOD-13 offer, cent for cent, or entered by hand — and then
delivered in as many delivery notes (Lieferscheine) as it takes. Each delivery
note is billed on its own in MOD-04: one invoice per delivery, exactly once.

```
MOD-13 offer (accepted) ──import──▶ order AB-2026-0001
                                     ├─ delivery note LS-2026-0001 ──▶ MOD-04 draft
                                     ├─ delivery note LS-2026-0002 ──▶ MOD-04 draft
                                     └─ cancel the rest (manage)
```

Part of the [0815software module catalogue](../README.md). MIT-licensed,
runs on its own, and follows the conventions of every other module: one Node
process, one SQLite file, no external services unless you wire them.

## Stack

| Layer   | Choice |
| ------- | ------ |
| API     | Node 20+ · Express 5 · TypeScript (strict) |
| Storage | better-sqlite3 (single file) |
| UI      | React 19 · Vite |
| Tests   | Vitest + Supertest |

## Quickstart

```sh
cd modules/mod-17-orders-delivery
npm install
npm run dev:api     # API on http://localhost:3017
npm run dev:web     # UI on http://localhost:5187 (proxies /api)
npm test
```

Local dev login: `admin` / `admin`.

## Data model

- `orders` — the confirmation: number, date, the customer as they ordered
  (a frozen copy, plus the identity they came with for PS-11), their own
  order number, the offer it came from, and `open` / `cancelled`.
- `order_lines` — what was ordered: quantity, unit price, line discount, VAT,
  and the MOD-03 article number (`sku`, null for a service).
- `settings` — what the admin set on the Settings screen, and who.
- `delivery_notes` · `delivery_note_lines` — what left on which day; set once
  by MOD-04 when it takes a delivery over (`invoiced_at`, `invoice_reference`),
  and what MOD-03 answered to its goods issue (`stock_status`, `stock_error`).
- `order_events` — append-only history: confirmed, delivered, invoiced,
  cancelled — each with the person.
- `counters` — the gapless numbers, per kind (`AB`, `LS`) and year.

## Rules the tests pin (`test/api.test.ts`)

- **Derived, never stored.** Delivered and open quantity per line, and the
  status (open → partly delivered → delivered), come from the delivery notes
  on every read. Only *cancelled* is stored — a decision, not a sum.
- **Never delivered past the order.** A delivery note takes at most what is
  open on each line, a line once, and only lines of its own order; quantities
  are compared in thousandths, so 0.7 + 0.8 of 1.5 is exactly all of it.
- **Documents are fixed and numbered.** `AB-<year>-<n>` and `LS-<year>-<n>`,
  gapless — a refused document consumes no number. No route edits or
  deletes an order or a delivery note. A delivery note is dated when the
  goods left: not in the future, not before the order.
- **Cancelling stops what is still open** (`manage`): written delivery notes
  stay valid and billable; a fully delivered order has nothing to cancel.
- **The offer comes over exactly.** Only an `offer` transfer becomes an order;
  its lines and totals must add up (`validateTransfer`), and an offer becomes
  at most one order (idempotent on `<module>:<offer number>`).
- **The delivery goes out exactly.** `GET /api/delivery-notes/:number/transfer`
  (machine token) is a valid `delivery` transfer — the delivered quantities
  at the order's prices and discounts, the customer with the identity it
  arrived with. MOD-04 bills it once; the hand-back is recorded once, naming
  the person who billed it.
- **Stock follows the delivery note, never the other way round**
  (`test/settings-stock.test.ts`). With booking on and MOD-03 wired, writing a
  delivery note issues its article lines (services are skipped) from the
  warehouse set, in the name of whoever wrote it. Short stock or MOD-03 down
  does not refuse the delivery — it happened — but marks the note *failed*
  with MOD-03's reason; *Book stock* retries, and MOD-03 books each note once.
  An article number set on a line later reaches the deliveries from then on.
- **Stock is reserved when an order is confirmed** (with reserving on in
  Settings and MOD-03 wired; `test/settings-stock.test.ts`). The ordered
  quantity per article goes to MOD-03, which derives what is still reserved
  as deliveries go out — each delivery note names its order. Changing an
  article number reserves again; cancelling releases. A shortage never
  refuses the order: it is recorded as *short* with what is missing, a
  failure as *failed*, and *Reserve again* retries.
- **The letterhead: Settings > PS-11 > environment, field by field**
  (`test/seller.test.ts`). What the admin sets wins; otherwise the stack's
  `self` party in PS-11 Customers (as in MOD-04); otherwise `SELLER_*`. A
  blank field in PS-11 falls through rather than blanking the letterhead; an
  unreachable PS-11 keeps the last party it gave, while "no party" restores
  the environment. Without `CUSTOMERS_URL` no call is ever made. A
  warehouse MOD-03 does not have is refused, and so is saving one while
  MOD-03 cannot be asked.
- Who may do what is decided in one file (see below), proven on the real routes.

## Users and access levels

Standalone, this module has one login — the local admin — and it manages
everything. With PS-01 Identity wired (`IDENTITY_URL` + `IDENTITY_ORG`), every
person signs in as themselves and gets the level PS-01 grants them here:

| PS-01 permission | Level | May |
| --- | --- | --- |
| `module:orders-delivery:view` | `view` | read everything, change nothing |
| `module:orders-delivery:edit` | `edit` | confirm orders, write delivery notes |
| `module:orders-delivery:manage` or `platform:admin` | `manage` | also what `server/access.ts` reserves |

Reads need `view`, any other method needs `edit`, and
[`server/access.ts`](./server/access.ts) names the exceptions
(`POST /api/orders/:id/cancel` and `PUT /api/settings` → `manage`). A refused request answers **403**;
`GET /api/me` reports the caller's `access`, and the UI hides what they cannot
do. The contract is [`docs/ACCESS-LEVELS.md`](../../docs/ACCESS-LEVELS.md).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3017` | API port |
| `DATABASE_PATH` | `./data.db` | SQLite file |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin` | local admin login |
| `SESSION_SECRET` | dev default | session HMAC key — **required** in production |
| `SESSION_TTL_HOURS` | `12` | session lifetime |
| `IDENTITY_URL` / `IDENTITY_ORG` | — | sign in through PS-01 Identity |
| `IDENTITY_PERMISSION` | — | legacy: one permission that admits as `manage` |
| `AUDIT_URL` / `PLATFORM_SERVICE_TOKEN` | — | record changes on PS-07 Audit Log; the token also guards the transfer routes |
| `OFFERS_URL` | — | MOD-13 Offers, to confirm an accepted offer as an order |
| `CUSTOMERS_URL` | — | PS-11 Customers: its `self` party is the letterhead (below Settings) |
| `SELLER_REFRESH_MS` | `300000` | how often that party is re-read |
| `INVENTORY_URL` | — | MOD-03 Inventory, to book delivery notes as goods issues (switched on, and the warehouse chosen, in Settings) |
| `SELLER_NAME` / `SELLER_ADDRESS` / `SELLER_VAT_ID` | placeholders | the default letterhead (`\|`-separated address), shared with MOD-04 and MOD-13 — the admin overrides it in Settings |
| `SHELL_ORIGIN` | — | MOD-15/16 shells allowed to embed this module |

## API

| Method & path | Level | Purpose |
| --- | --- | --- |
| `POST /api/login` · `GET /api/auth-mode` | public | sign in; which credentials apply |
| `GET /api/me` | view | who is signed in, and their `access` |
| `GET /api/orders` | view | list; `?status=`, `?search=` |
| `GET /api/orders/:id` · `GET /api/orders/:id/pdf` | view | detail with lines, deliveries, history; the order confirmation |
| `POST /api/orders` | edit | confirm an order entered by hand |
| `POST /api/orders/import-offer` | edit | `{offer_number}` — confirm an accepted MOD-13 offer (501 without `OFFERS_URL`) |
| `POST /api/orders/:id/delivery-notes` | edit | `{lines:[{order_line_id, quantity}], delivered_on?, note?}` |
| `GET /api/delivery-notes/:id/pdf` | view | the delivery note, without prices |
| `POST /api/orders/:id/reserve-stock` | edit | reserve (again) the order's articles in MOD-03 (501 without `INVENTORY_URL`) |
| `POST /api/delivery-notes/:id/book-stock` | edit | book (again) its goods issue in MOD-03 (501 without `INVENTORY_URL`) |
| `PUT /api/orders/:id/lines/:lineId/sku` | edit | `{sku}` — map a line to a MOD-03 article (empty = service) |
| `GET /api/settings` | view | letterhead (with each field's source), stock booking, MOD-03's warehouses |
| `PUT /api/settings` | manage | `{seller_name, seller_address[], seller_vat_id, stock_booking, stock_warehouse}` |
| `POST /api/orders/:id/cancel` | manage | `{reason}` — cancel what is still open |
| `GET /api/delivery-notes/:number/transfer` | machine token | the delivery as a `delivery` document transfer |
| `POST /api/delivery-notes/:number/invoiced` | machine token | `{reference, actor}` — MOD-04 took it over (idempotent) |
| `GET /api/summary` | machine token | what a shell shows (`docs/SHELL-CONTRACT.md`) |

## Scripts

`dev:api`, `dev:web`, `seed`, `build`, `start`, `backup`, `test`.

## Out of scope

- **Several warehouses per order.** One warehouse per installation reserves
  and issues the goods; picking lists and backorder automation are
  commissioned work.
- **Returns and corrections of a delivery.** A delivery note is a fact; goods
  coming back are a credit note in MOD-04 (and, later, a return document).
- **Changing an order.** Lines are fixed once confirmed. A different order is
  a cancellation of the rest and a new order.
- **Prices other than the order's.** A delivery is billed at the price
  ordered; surcharges or freight are added on the MOD-04 draft before it is
  sent.
- **Shipping carriers, tracking numbers, pick lists.** Commissioned work.

## Platform integration (optional)

Every integration is opt-in and best-effort: unset, the module runs
standalone with no outbound calls. PS-01 Identity for sign-in and access
levels, PS-07 Audit Log for the activity trail, PS-11 Customers for the
letterhead. Peers: MOD-13 Offers
(`OFFERS_URL`) for the import; MOD-03 Inventory (`INVENTORY_URL`) for goods
issues; MOD-04 Invoice & Billing calls this module
with `ORDERS_URL` set on its side.

What each one missing means — the module itself never needs any of them:

| Not wired | What happens |
| --- | --- |
| MOD-13 (`OFFERS_URL`) | orders are entered by hand; *Confirm offer* answers 501 |
| MOD-03 (`INVENTORY_URL`) | orders and delivery notes are written, no stock is reserved or booked; *Reserve again* / *Book stock* answer 501 |
| MOD-04 (no `ORDERS_URL` there) | delivery notes are printed and billed by hand; they show *not yet invoiced* |
| PS-11 (`CUSTOMERS_URL`) | the letterhead is Settings, then `SELLER_*` |
| PS-01 / PS-07 | the local admin signs in; no audit trail |

`test/seller.test.ts` and `test/settings-stock.test.ts` run these cases with
nothing wired, and the stack smoke test boots the module with no URLs at all.

## The shell contract — appearing on a dashboard

`GET /api/summary` (machine token) and, with `SHELL_ORIGIN` set, the
handoff routes. See [`docs/SHELL-CONTRACT.md`](../../docs/SHELL-CONTRACT.md).

## License

MIT © 2026 0815software. See [LICENSE](./LICENSE).
