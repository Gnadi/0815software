# MOD-08 · Reporting Suite

Scheduled exports, pivot tables, and chart embeds built on top of your
existing database. Part of the [0815software](https://0815software.com)
module catalogue — standard business software, MIT-licensed, always
free.

The point of this module is to let one trusted admin turn a SQLite
database into saved reports, server-computed pivots, hand-rolled SVG
charts (with signed, session-free embed URLs) and scheduled CSV exports —
**without ever writing to the database it reports on.** That read-only
guarantee is the core safety property, and the test suite proves it from
several angles.

Three properties are the reason this module exists, and each is pinned by
a test:

1. **Reports are SELECT-only, enforced in depth.** A report is a name +
   a SQL SELECT. The server validates it (single statement, must start
   with `SELECT`/`WITH`, no write/DDL/`PRAGMA`/`ATTACH` keywords,
   literal-aware) *and* runs it on a connection opened
   `{ readonly: true }`, so even a query that slipped past the validator
   cannot mutate anything. Rejected queries are a clean `422`.
2. **Pivots are computed from the underlying rows, not from other
   cells.** Every margin — row totals, column totals, grand total — is
   the aggregation applied to the real source rows, so an `avg` margin is
   a true average and every number is hand-computable.
3. **Charts embed without a session, but only their own chart.** Each
   saved chart has an HMAC-signed embed token bound to that chart id.
   `/embed/chart/:id?token=…` renders the SVG standalone; a missing,
   tampered or cross-chart token is a `404`.

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-07):

| Layer    | Choice                                      |
| -------- | ------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)       |
| API      | Node + Express 5                            |
| Storage  | better-sqlite3 (single file, zero services) |
| Charts   | Hand-rolled SVG — **no chart library**      |
| Styling  | Hand-rolled CSS, no framework               |
| Tests    | Vitest + Supertest                          |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all — no CDN, no external services, no chart library.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-08-reporting-suite
npm install
npm run seed          # generates the demo source db + example reports (idempotent)

# terminal 1 — API on :3008
npm run dev:api

# terminal 2 — UI on :5198 (proxies /api and /embed to :3008)
npm run dev:web
```

Open http://localhost:5198 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3008
```

On first start with no `SOURCE_DB_PATH` set, the server generates a
deterministic **demo source database** (`./source.db` — a year of sales:
regions, products, orders, order lines, a few thousand rows) and seeds
its own metadata db with five example reports, two charts and a daily
schedule, so everything works out of the box. No binary database is
committed; delete `data.db`/`source.db` any time to start fresh.

## Two databases, one of them read-only

This module keeps a hard wall between the data it reports on and its own
bookkeeping:

- **Source database** (`SOURCE_DB_PATH`) — the SQLite file you want to
  report on. Opened **strictly read-only** (`better-sqlite3`
  `{ readonly: true, fileMustExist: true }`). The module never writes to
  it, never migrates it, never creates it. If you set `SOURCE_DB_PATH` to
  a file that doesn't exist, the server refuses to start.
- **Metadata database** (`DATABASE_PATH`) — the module's own file holding
  `reports`, `charts`, `schedules` and the append-only `runs` history.
  Created and owned by the module.

### Point it at your own database

```sh
export SOURCE_DB_PATH=/srv/data/mywarehouse.db   # your read-only source
export DATABASE_PATH=/var/lib/mod08/data.db      # module's own metadata
npm start
```

Then write reports against **your** tables. The report editor shows the
source schema (tables and columns) discovered from the read-only
connection, so you can see exactly what's queryable.

**Postgres / MySQL adapters are out of scope** — this module is
SQLite-first (see the out-of-scope list). If your data lives in another
engine, export or mirror the slice you want to report on into a SQLite
file (a nightly dump is a common pattern) and point `SOURCE_DB_PATH` at
that.

### Reporting on a module that publishes a contract

A module in this catalogue can publish a set of `report_*` **views** in its
own database. Those views are its public contract; its tables stay private
and refactorable. MOD-04 Invoice & Billing is the reference implementation —
see [`docs/REPORTING-CONTRACT.md`](../../docs/REPORTING-CONTRACT.md).

Set **`SOURCE_VIEWS_ONLY=true`** to hold this module to that contract:

```sh
export SOURCE_DB_PATH=/source/data.db   # the other module's volume, read-only
export SOURCE_VIEWS_ONLY=true
```

In a generated stack you do not set this by hand: `deploy/provision.mjs`
emits it automatically when `--source-db` names a module that publishes a
contract (MOD-04 does).

With it on, `GET /api/source` lists only the source's **published views** —
the editor never offers a private table — and a query that reads anything
else is refused with a `422` at save time *and* at run time. The restriction
is on the objects a query **reads**, so none of these get round it:

- an alias — `FROM customers AS report_c` reads `customers`;
- a CTE — its body is scanned like any other `FROM`;
- a subquery, at any depth, or a comma-join after a join constraint;
- a **parenthesised table list or join** — `FROM (customers)`,
  `FROM (customers, report_invoices)` — which SQLite allows and which is not
  a subquery;
- a quoted/bracketed identifier, a schema qualifier, or different casing;
- a table that merely happens to be **named** `report_something`. The
  source's own catalog authorises objects and it lists **views only**; the
  prefix is a naming convention, not the boundary.

CTEs, subqueries, joins, unions and window functions all keep working. The
allowed set is read from the catalog on every check, so a view the source
publishes later is usable without restarting this module. One shape is
over-refused: a CTE declared *inside* a subquery — declare it at the top
level instead.

It is **off by default**, and off changes nothing: pointed at an arbitrary
customer database there is no contract to enforce, and the whole schema is
the point. This is a *scope* restriction layered on top of the read-only
connection, not a replacement for it.

### Provisioning it standalone

`SOURCE_DB_PATH` is optional in every sense, including in a generated stack:

```sh
node deploy/provision.mjs --customer solo --modules mod-08-reporting-suite \
  --domain solo.example --out ./customers/solo
```

is a valid single-module stack — MOD-08 generates its own source database on
first boot. Add `--source-db <module-id>` to mount another selected module's
volume read-only at `/source` instead.

## Reports

A report is `{ name, description?, sql }`. The SQL must be a single
read-only statement. Validation (in `server/query-policy.ts`, the one
place the rules live) rejects, with a `422`:

- anything that isn't a single statement (`SELECT 1; DELETE …` → rejected,
  including a write hidden after a `SELECT`);
- anything not starting with `SELECT` or `WITH`;
- any of `INSERT UPDATE DELETE REPLACE DROP CREATE ALTER TRUNCATE PRAGMA
  ATTACH DETACH VACUUM REINDEX GRANT REVOKE BEGIN COMMIT ROLLBACK
  SAVEPOINT` as a **whole word** in the code (string literals and quoted
  identifiers are stripped first, so `SELECT 'DELETE me'` and a column
  aliased `"update"` are fine);
- and, **only when `SOURCE_VIEWS_ONLY=true`**, anything that reads an object
  the source's catalog does not list as a published `report_*` view — plus
  anything whose `FROM`/`JOIN` the scanner cannot classify (see above).

The validator is a fast, explanatory gate. The **backstop** is the
read-only connection: a write that somehow reached SQLite fails with
*"attempt to write a readonly database"*. Both are tested, including a
test that inserts a raw `DELETE` straight into the metadata table
(bypassing the validator) and confirms running it is still a `422`.

**Limits** (also in `server/query-policy.ts`): results are capped at
**10,000 rows** (`truncated: true` is returned when the cap bites), and a
single query has a **5,000 ms** wall-clock budget. Change the constants
in that file; a startup self-check keeps them sane.

Run a report at `POST /api/reports/:id/run` → `{ columns, rows,
truncated, elapsed_ms }`. Download the same result as CSV at
`GET /api/reports/:id/export.csv`.

## Pivot tables

For any report result, a pivot config computes a cross-tab **server-side**:

```jsonc
{
  "row": "category",          // column whose distinct values become rows
  "col": "region",            // optional column → value columns (null = flat)
  "measure": "revenue_cents", // column the measure reads ('*' for count)
  "aggregation": "sum"        // sum | count | avg | min | max
}
```

`POST /api/reports/:id/pivot` returns row keys, per-cell values, row
totals, a `columnTotals` array and a single `grandTotal`. Semantics that
matter:

- **Empty cells are `null`** (no source rows at that row×column), not `0`.
- **Totals are honest.** Each margin is the aggregation over the real
  underlying rows, so an `avg` grand total is the mean of every row, not
  an average of averages.
- **`count` counts records** and ignores the measure column (`'*'` is the
  idiomatic spelling); `sum/avg/min/max` skip null / non-numeric values.

The tests hand-compute a small fixture (including an empty cell and grand
totals) for `sum`, `count` and `avg`, and cross-check an API pivot cell
against the source database directly.

## Charts

Bar and line charts are rendered as **hand-rolled SVG on the server** from
a report result and a `{ kind, x, y }` config — no chart library. The y
axis uses a linear scale with "nice" 1/2/5 tick steps; x labels are
thinned so they don't overlap. The SVG inlines its own colours (the 0815
token palette) so it needs no external stylesheet, which is what makes it
safe to drop into an `<img>` or `<iframe>`.

Build one interactively in a report's **Chart** tab (live preview +
save), or:

```
GET  /api/charts/:id/svg              authed SVG of a saved chart
POST /api/reports/:id/chart-preview   { kind, x_column, y_column } → SVG (unsaved)
```

## Chart embeds

Every saved chart has a stable, HMAC-signed embed URL:

```
/embed/chart/:id?token=<hmac(secret, "embed:chart:<id>")>
```

`GET /api/charts/:id/embed` returns the `path`. The embed route renders
the chart's SVG **with no session** — that's the point, it goes in a
dashboard or wiki iframe:

```html
<iframe src="https://reports.example.com/embed/chart/7?token=…"
        width="720" height="360" frameborder="0"></iframe>
```

The token is bound to that specific chart id, so it only ever renders
chart 7. A missing, tampered or foreign token (a token minted for a
different chart) returns **404** — the URL either resolves to exactly its
chart or it doesn't exist. Embed tokens carry no expiry (an embed URL is a
long-lived capability); **rotating `SESSION_SECRET` invalidates every
embed URL** (and logs everyone out).

## Scheduled exports

Each report can have one schedule: an interval (`hourly` or `daily`) and a
format (`csv`). An **in-process scheduler** (a plain `setInterval`, tick
period `SCHEDULER_TICK_SECONDS`) runs due schedules while the server is
up. Each run:

- executes the report against the read-only source db,
- writes a CSV into the exports directory (`EXPORTS_DIR`, gitignored),
- appends **one immutable row** to the append-only `runs` history
  (report, trigger, status, started/finished, row count, file path, or
  error).

The row count written to history is exactly the number of data rows in
the CSV, so a run's history row and its file can never disagree (a test
pins this).

**Honest scheduling — the limitations, stated plainly:**

- There is **no external cron.** Schedules only fire while this process
  runs. Put it under a process manager (systemd, Docker restart policy)
  if you need it always-on.
- **Next-due is derived** from `last_run_at` + the interval; it is never
  stored, so it can't drift.
- **No catch-up backfill.** If the server was down across several
  intervals, a schedule runs **once** on the next tick and the clock
  restarts from there — you don't get a burst of missed runs. This is a
  deliberate simplicity choice.
- A **"Run now"** button/endpoint runs a report on demand at any time
  (per report, or per schedule) — independent of the interval.

## UI

- **Reports** — list/search, create/edit with a live-preview table and
  the source schema; per-report CSV download and delete.
- **Report workspace** — Preview / Pivot / Chart tabs over one report,
  plus "Run export now".
- **Pivot builder** — pick row/column/measure/aggregation, see the pivot
  with row, column and grand totals rendered.
- **Chart builder** — pick kind/x/y, live SVG preview, save, copy the
  embed URL + ready-made `<iframe>` snippet.
- **Charts** — all saved charts with their rendered SVG and embed URLs.
- **Schedules** — per-report schedule config, next-due, "Run now", and
  the append-only run history.
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (`mod08_session`, HttpOnly, SameSite=Lax, optional
  Secure), exactly as in MOD-02 … MOD-07.

## Configuration

All runtime settings via environment variables (see
[`.env.example`](.env.example)):

| Variable                 | Default                | Purpose                                                    |
| ------------------------ | ---------------------- | ---------------------------------------------------------- |
| `PORT`                   | `3008`                 | API / production server port                               |
| `DATABASE_PATH`          | `./data.db`            | Module's own metadata db (created on demand)               |
| `SOURCE_DB_PATH`         | `./source.db` (demo)   | Database to report on — opened **read-only**; must exist if set |
| `SOURCE_VIEWS_ONLY`      | `false`                | `true` restricts every report to the source's published `report_*` views |
| `EXPORTS_DIR`            | `./exports`            | Where scheduled/manual export CSVs are written (gitignored) |
| `SCHEDULER_TICK_SECONDS` | `60`                   | How often the in-process scheduler checks for due schedules |
| `ADMIN_USERNAME`         | `admin`                | Login user                                                 |
| `ADMIN_PASSWORD`         | `admin`                | Login password — **change in prod**                        |
| `SESSION_SECRET`         | `dev-secret-change-me` | HMAC key for the session cookie **and** embed tokens       |
| `SESSION_TTL_HOURS`      | `12`                   | Session lifetime                                           |
| `COOKIE_SECURE`          | `false`                | Set `true` behind HTTPS                                    |

The query row cap and time limit are deliberately *code* config
(`server/query-policy.ts`), not env vars — they are structured data with
a startup self-check. The server prints a warning while the default
password is in use. The dev server does not load `.env` by itself —
export the variables in your shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except for
`POST /api/login`, `GET /api/health` and valid `/embed/chart/:id` URLs.

```
POST   /api/login                        {username, password} → session cookie
POST   /api/logout
GET    /api/me
GET    /api/source                       source schema (tables/columns) + query policy
                                         (report_* only when SOURCE_VIEWS_ONLY=true)

GET    /api/reports                      ?search= → saved reports
POST   /api/reports                      {name, description?, sql}  (SELECT-only → 422)
GET    /api/reports/:id
PUT    /api/reports/:id                  {name, description?, sql}
DELETE /api/reports/:id                  cascades charts/schedule/history
POST   /api/reports/:id/run              → {columns, rows, truncated, elapsed_ms}
POST   /api/preview                      {sql} → run ad-hoc SQL (edit-time preview)
GET    /api/reports/:id/export.csv       result as a CSV download
POST   /api/reports/:id/pivot            {row, col?, measure, aggregation} → pivot
POST   /api/reports/:id/chart-preview    {kind, x_column, y_column} → SVG (unsaved)
POST   /api/reports/:id/run-now          run an export now → runs row

GET    /api/charts
POST   /api/charts                       {report_id, name, kind, x_column, y_column}
GET    /api/charts/:id
DELETE /api/charts/:id
GET    /api/charts/:id/svg               authed SVG
GET    /api/charts/:id/embed             → {chart_id, token, path}

GET    /api/schedules                    with derived next_due_at
PUT    /api/schedules/report/:reportId   {interval, enabled?} — upsert (one per report)
DELETE /api/schedules/:id
POST   /api/schedules/:id/run-now        run this schedule's report now

GET    /api/runs                         ?report_id= → append-only run history

GET    /embed/chart/:id?token=…          PUBLIC signed SVG; bad/foreign token → 404
GET    /api/health                       liveness
```

Validation failures return `422` with `{error, details?}`; missing
resources return `404`.

## Scripts

| Script            | What it does                                             |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` + `/embed` proxy            |
| `npm run seed`    | Generate the demo source db + seed metadata (idempotent) |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | Vitest + Supertest suite                                |

The tests prove: every SELECT-only rejection case (INSERT/UPDATE/DELETE/
DROP/PRAGMA/ATTACH/multi-statement) at the validator and over the API; the
read-only connection as backstop; the 10,000-row cap with truncation;
pivot correctness (sum/count/avg/min/max, empty cells, row/column/grand
totals) against hand-computed values and the source db; chart SVG element
counts for a known dataset; embed token valid/invalid/cross-chart; a
schedule/manual run appending history and writing a CSV whose row count
matches the query; the scheduler tick firing a due schedule once (no
backfill); `SOURCE_VIEWS_ONLY` in both modes — off changes nothing, on
refuses a private table and cannot be evaded by an alias, a CTE, a
subquery, a comma-join, a parenthesised table list, a quoted identifier or a
private table named `report_*`, while CTEs and subqueries over published
views keep working; and `401` everywhere without a session except valid
embeds.

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS with a persistent disk (both the
  metadata db and the exports dir must survive restarts — mount volumes
  for `DATABASE_PATH` and `EXPORTS_DIR`; mount `SOURCE_DB_PATH`
  read-only).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`), `COOKIE_SECURE=true`, and terminate TLS in
  front (Caddy/nginx).
- The scheduler runs **in-process** — keep the process up (or restart it
  automatically) for schedules to fire.
- Not a fit for serverless: SQLite and the exports dir want a persistent
  filesystem.

## Out of scope

Kept out deliberately to stay a 3–4 week module. If you need any of
these, that's commissioned work — exactly the kind 0815software does:

- **Postgres / MySQL / other engines.** SQLite-first by design. Mirror
  the slice you want to report on into a SQLite file and point
  `SOURCE_DB_PATH` at it.
- **User management, roles, per-report permissions.** One staff admin, as
  in every 0815 module. Embed URLs are the only unauthenticated surface,
  and each is scoped to a single chart.
- **External cron / distributed scheduling.** The scheduler is in-process
  with no catch-up backfill (documented above). Cron-grade guarantees are
  an extension.
- **Formats beyond CSV.** Exports are CSV; XLSX/Parquet/JSON exports and
  emailed/pushed deliveries (SMTP, S3, webhooks) are out — this module has
  zero external services.
- **Charts beyond bar/line.** Two hand-rolled SVG chart types. Pie,
  stacked, scatter, multi-series, tooltips and interactivity are an
  extension of the same no-library renderer.
- **Query builder / visual SQL.** Reports are hand-written SELECTs; a
  drag-and-drop query designer is a separate product.
- **Parameterised / scheduled-with-parameters reports.** A report is a
  fixed SELECT; runtime parameters and prompt-driven filters are out.

## License

MIT © 0815software — see [LICENSE](LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, report runs are recorded
on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the shared
[`@0815software/platform-clients`](../../platform/clients) package. Best-effort
and opt-in — unset, the module runs standalone. See `server/platform.ts`.

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
