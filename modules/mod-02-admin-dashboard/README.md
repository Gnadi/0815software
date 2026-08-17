# MOD-02 · Admin Dashboard

Internal CRUD interface over any data model. Tables, filters, bulk actions,
exports. Part of the [0815software](https://0815software.com) module
catalogue — standard business software, MIT-licensed, always free.

The dashboard is **config-driven**: you describe your data model once, in a
single TypeScript file, and the whole application — SQLite schema, REST API,
validation, list views, filter row, forms, CSV exports — derives from it.
No code generation, no migrations tool, no external services.

## Stack

Deliberately standard and boring:

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Styling  | ~500 lines of hand-rolled CSS, no framework   |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-02-admin-dashboard
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3002
npm run dev:api

# terminal 2 — UI on :5192 (proxies /api to :3002)
npm run dev:web
```

Open http://localhost:5192 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3002
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional — it exists so you can (re)create the database
without starting the server. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Pointing it at your own data model

Everything lives in [`shared/resources.ts`](shared/resources.ts). A resource
is a name, a label and a list of fields:

```ts
{
  name: 'invoices',            // URL slug + SQLite table name
  label: 'Invoices',
  description: 'Outgoing invoices with payment status.',
  fields: [
    { name: 'number',   label: 'Invoice no.', type: 'text',   required: true, pattern: '^INV-\\d+$' },
    { name: 'amount',   label: 'Amount',      type: 'number', required: true, min: 0 },
    { name: 'paid',     label: 'Paid',        type: 'boolean' },
    { name: 'due_date', label: 'Due date',    type: 'date' },
    { name: 'state',    label: 'State',       type: 'select', options: ['draft', 'sent', 'overdue'] },
  ],
}
```

Field types: `text`, `number`, `boolean`, `date`, `select`. Validation
options per field: `required`, `min`/`max` (number), `maxLength`, `pattern`
+ `patternHint` (text), `options` (select). `hideInTable: true` keeps a
field out of the list view but in the form.

Add or edit resources, restart the server, done: tables are created with
`CREATE TABLE IF NOT EXISTS`, the sidebar, list view, filter row, form and
CSV export all follow the config. (Changing *fields of an existing table*
is a schema migration — SQLite makes that easy with `ALTER TABLE ADD
COLUMN`, or just delete `data.db` during development.)

Seed data for the three example resources (customers, products, orders)
lives in [`server/seed.ts`](server/seed.ts); replace it alongside your
config or delete the entries you don't need. Seeding only ever touches
empty tables.

## Features

- **List views** — full-text search across text/select columns, per-column
  filters (contains for text, exact for select/date/number, yes/no for
  boolean), click-to-sort on every column, pagination (25 rows/page).
- **CRUD** — create/edit in a modal form derived from the field config,
  server-side validation with per-field error messages, delete with
  confirmation.
- **Bulk actions** — select rows via checkboxes, then bulk delete or export
  exactly the selection as CSV.
- **CSV export** — per-resource full export (respects the active search,
  filters and sort), RFC-4180 quoting, served as a download.
- **Auth** — single admin login from env vars; stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, optional Secure).

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                | Purpose                                  |
| ------------------- | ---------------------- | ---------------------------------------- |
| `PORT`              | `3002`                 | API / production server port             |
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
POST   /api/login                      {username, password} → session cookie
GET    /api/auth-mode                  local or SSO — which credentials to name
POST   /api/logout
GET    /api/config                     resource definitions
GET    /api/:resource                  ?search=&f_<field>=&sort=&dir=&page=&pageSize=
GET    /api/:resource/:id
POST   /api/:resource                  create (422 + details on validation error)
PUT    /api/:resource/:id              full update
DELETE /api/:resource/:id
POST   /api/:resource/bulk-delete      {ids: number[]}
GET    /api/:resource/export.csv       ?ids=1,2 for a selection, otherwise
                                       full export honouring search/filter/sort
```

## Scripts

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` proxy                       |
| `npm run seed`    | Create/seed the SQLite database                         |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | API smoke tests (Vitest + Supertest, in-memory SQLite)  |

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`) and `COOKIE_SECURE=true`, and terminate TLS in
  front (Caddy/nginx).
- Not a fit for serverless platforms: SQLite wants a persistent filesystem.
- Scope note: this ships a single admin account by design. If you need
  roles, audit logs or SSO, that's commissioned work — exactly the kind
  0815software does.

## License

MIT © 0815software — see [LICENSE](LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records key
state changes on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the
shared [`@0815software/platform-clients`](../../platform/clients) package.
Calls are best-effort and opt-in — unset, the module runs standalone with no
outbound calls. See `server/platform.ts`.
