# MOD-08 · Reporting Suite

Scheduled exports, pivot tables, and chart embeds built on top of your
existing database. Part of the [0815software](https://0815software.com)
module catalogue — standard business software, MIT-licensed, always
free.

The point of this module is to let one trusted admin turn a SQLite
database into saved reports — with parameters such as "from" and "to" —
server-computed pivots, hand-rolled SVG charts (bar, line, area, pie; one
series or several; with signed, session-free embed URLs) and scheduled CSV
or Excel exports — **without ever writing to the database it reports on.** That read-only
guarantee is the core safety property, and the test suite proves it from
several angles.

Four properties are the reason this module exists, and each is pinned by
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
4. **A parameter value is bound, never spliced.** A report names its
   placeholders (`:from`, `:region`) and SQLite binds the values, so a
   value cannot change what the query does — `North' OR '1'='1` is a
   region nobody has. Declarations and SQL must agree before a report is
   saved.

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-07):

| Layer    | Choice                                      |
| -------- | ------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)       |
| API      | Node + Express 5                            |
| Storage  | better-sqlite3 (single file, zero services) |
| Charts   | Hand-rolled SVG — **no chart library**      |
| Excel    | Hand-built OOXML + Node's zlib — **no library** |
| Styling  | Hand-rolled CSS, no framework               |
| Tests    | Vitest + Supertest                          |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all — no CDN, no external services, no chart or spreadsheet
library.

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
`GET /api/reports/:id/export.csv`, or as Excel at
`GET /api/reports/:id/export.xlsx` (see [Excel export](#excel-export)).

### Parameters

A report may name placeholders in its SQL and declare each one:

```sql
SELECT r.name AS region, SUM(ol.quantity * ol.unit_price_cents) AS revenue_cents
FROM orders o JOIN regions r ON r.id = o.region_id JOIN order_lines ol ON ol.order_id = o.id
WHERE o.order_date BETWEEN :from AND :to
  AND (:region IS NULL OR r.name = :region)
GROUP BY r.id
```

```jsonc
"params": [
  { "name": "from",   "label": "From",   "type": "date",   "required": true, "default": "prev_month_start" },
  { "name": "to",     "label": "To",     "type": "date",   "required": true, "default": "prev_month_end" },
  { "name": "region", "label": "Region", "type": "choice", "choices": ["North", "South"] }
]
```

- **Types:** `text`, `number`, `date`, `choice` (one of a fixed list). At
  most 20 per report. A `required` one with neither value nor default is a
  `422` naming it — before anything runs, so the run history only holds
  what ran. An optional one left empty binds `NULL`; write the SQL for it
  as above.
- **Values are bound by SQLite** (`server/params.ts`), never written into
  the SQL text; the SELECT-only policy and the read-only connection stand
  as before.
- **Declarations and SQL agree, or the report is not saved.** A `:name`
  nobody declared, a declaration the SQL never uses, a positional `?`, or
  an `@name`/`$name` spelling is a `422` with a message saying which.
  Placeholders inside string literals and comments are not placeholders.
- **Relative dates.** A date value or default may be `today`, `yesterday`,
  `today-7` / `today+30`, `week_start` (Monday), `month_start`,
  `month_end`, `prev_month_start`, `prev_month_end`, `year_start`,
  `prev_year_start`, `prev_year_end`. They are resolved **when the report
  runs**, in the time zone set under [Settings](#settings) — so a schedule
  saved with "start of last month" always exports the month before, and
  the export just after midnight on the 1st reports the right month.
- **Who chooses the values.** Anyone who can run a report (`view`) fills
  in the values when running, downloading or pivoting; a link carries them
  as `?p_from=2026-09-01&p_region=North`. Declaring parameters is part of
  the report's SQL and needs `manage`, like the SQL itself.
- **Saved values.** A schedule and a chart store their own values,
  relative dates kept relative. A stored value for a parameter the report
  has since dropped is ignored, not fatal; the run history records the
  values each run bound, relative dates resolved.

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

A built pivot downloads with the result as a second Excel sheet ("Excel
with pivot" in the Pivot tab).

## Excel export

`GET /api/reports/:id/export.xlsx` returns the result as an Excel workbook
— the same rows as the CSV, with the parameter values from `p_<name>`.
Add `pivot_row`, `pivot_col`, `pivot_measure` and `pivot_aggregation` and
the pivot comes as a second sheet, with its totals row. Scheduled and
manual exports can be written as `.xlsx` too.

The file is written by hand (`server/xlsx.ts`, `server/zip.ts`, ~400
lines): SpreadsheetML parts in a ZIP package, compressed with Node's own
zlib. What a reader gets:

- **numbers as numbers, text as text** — `01067` stays a postcode, not
  1067; integers past 2^53 stay exact, as text;
- **dates as dates** — a column whose every value is an ISO date or
  date-time becomes Excel dates (formatted, sortable, filterable); one
  stray text value keeps the column as text rather than guessing;
- **no formulas, ever** — every string is an inline string, so a value
  such as `=HYPERLINK(…)` is shown as text and never evaluated (the
  injection the CSV export has to escape cannot occur here);
- a bold, frozen header row with an autofilter.

**Evidence, not plausibility:** the tests validate every part of a
generated workbook with `xmllint` against the ECMA-376 schemas
(Transitional SpreadsheetML and the Open Packaging Conventions, vendored
in [`test/schema/ecma-376`](test/schema/ecma-376/README.md)), and check
Excel's date serials against the published reference values. Like MOD-04's
SEPA test, the schema check is skipped when `xmllint` is not installed; CI
installs it, so there it always runs.

## Charts

Charts are rendered as **hand-rolled SVG on the server** from a report
result and a config — no chart library:

| Kind   | What it draws |
| ------ | ------------- |
| `bar`  | one bar per row; with a series column, grouped bars — or `stacked` |
| `line` | one line; with a series column, one line per series |
| `area` | a filled line; with a series column, one area per series — or `stacked` |
| `pie`  | a donut: one slice per x value, the total in the middle, each share in the legend |

A **series column** (`series_column`) turns long rows — `month, category,
revenue` — into one series per distinct value, with a legend. Rows that
share an x and a series are summed; past eight series the lightest are
summed into a grey "Other". A series with no row for an x is a gap: a
line breaks there instead of dropping to zero. A pie sums by label and
leaves out values of zero or less — and says how many. Each bar, point
and slice carries a `<title>`, so hovering shows its value.

The y axis uses a linear scale with "nice" 1/2/5 tick steps; x labels are
thinned so they don't overlap. The SVG inlines its own colours (the 0815
token palette) so it needs no external stylesheet, which is what makes it
safe to drop into an `<img>` or `<iframe>`.

Build one interactively in a report's **Chart** tab (live preview +
save), or:

```
GET  /api/charts/:id/svg              authed SVG of a saved chart
POST /api/reports/:id/chart-preview   { kind, x_column, y_column, series_column?, stacked?, params? } → SVG (unsaved)
```

A chart saved from a report with parameters keeps the values it was saved
with (`param_values`) — relative dates stay relative, so "this month" is
still this month next month.

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
chart 7 — with its saved parameter values: the query string of an embed
URL cannot change them. A missing, tampered or foreign token (a token minted for a
different chart) returns **404** — the URL either resolves to exactly its
chart or it doesn't exist. Embed tokens carry no expiry (an embed URL is a
long-lived capability); **rotating `SESSION_SECRET` invalidates every
embed URL** (and logs everyone out).

## Scheduled exports

Each report can have one schedule: an interval (`hourly` or `daily`), a
format (`csv` or `xlsx`) and, for a report with parameters, the values to
run with. An **in-process scheduler** (a plain `setInterval`, tick
period `SCHEDULER_TICK_SECONDS`) runs due schedules while the server is
up. Each run:

- resolves the parameter values (relative dates in the module's time zone),
- executes the report against the read-only source db,
- writes a CSV or Excel file into the exports directory (`EXPORTS_DIR`,
  gitignored),
- appends **one immutable row** to the append-only `runs` history
  (report, trigger, status, started/finished, row count, file path or
  error, and the values it bound).

The row count written to history is exactly the number of data rows in
the file, so a run's history row and its file can never disagree (a test
pins this). Updating a schedule without `format` or `params` keeps the
ones it has — switching it off does not reset what it runs with.

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
  the source schema, and the parameter declarations (one click declares a
  `:name` the SQL uses); per-report CSV and Excel download and delete.
- **Report workspace** — the parameter form, Preview / Pivot / Chart tabs
  over one report, CSV and Excel downloads with the values entered, and
  "Run export now" as CSV or Excel.
- **Pivot builder** — pick row/column/measure/aggregation, see the pivot
  with row, column and grand totals rendered; download it with the result
  as Excel.
- **Chart builder** — pick kind (bar, line, area, pie), x/y, an optional
  series column and stacking, live SVG preview, save with the current
  parameter values, copy the embed URL + ready-made `<iframe>` snippet.
- **Charts** — all saved charts with their rendered SVG, saved values and
  embed URLs.
- **Schedules** — per-report interval, format and parameter values,
  next-due, "Run now", and the append-only run history with the values
  each run used.
- **Settings** — the time zone relative dates are resolved in (changing
  it needs `manage`).
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (`mod08_session`, HttpOnly, SameSite=Lax, optional
  Secure), exactly as in MOD-02 … MOD-07.

## Settings

What an administrator sets in the UI (**Settings**, `manage` to change):

| Setting   | Default         | Purpose |
| --------- | --------------- | ------- |
| Time zone | `Europe/Vienna` | When "today" begins for relative parameter dates — any IANA zone; an unknown one is a `422`. The change records who made it. |

## Configuration

All runtime settings via environment variables (see
[`.env.example`](.env.example)):

| Variable                 | Default                | Purpose                                                    |
| ------------------------ | ---------------------- | ---------------------------------------------------------- |
| `PORT`                   | `3008`                 | API / production server port                               |
| `DATABASE_PATH`          | `./data.db`            | Module's own metadata db (created on demand)               |
| `SOURCE_DB_PATH`         | `./source.db` (demo)   | Database to report on — opened **read-only**; must exist if set |
| `SOURCE_VIEWS_ONLY`      | `false`                | `true` restricts every report to the source's published `report_*` views |
| `EXPORTS_DIR`            | `./exports`            | Where scheduled/manual export files (CSV, XLSX) are written (gitignored) |
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
GET    /api/auth-mode                    local or SSO — which credentials to name
POST   /api/logout
GET    /api/me
GET    /api/source                       source schema (tables/columns) + query policy
                                         (report_* only when SOURCE_VIEWS_ONLY=true)

GET    /api/reports                      ?search= → saved reports
POST   /api/reports                      {name, description?, sql, params?}  (SELECT-only → 422)
GET    /api/reports/:id
PUT    /api/reports/:id                  {name, description?, sql, params?}
DELETE /api/reports/:id                  cascades charts/schedule/history
POST   /api/reports/:id/run              {params?} → {columns, rows, truncated, elapsed_ms}
POST   /api/preview                      {sql, params?, values?} → run ad-hoc SQL (edit-time preview)
GET    /api/reports/:id/export.csv       ?p_<name>= → result as a CSV download
GET    /api/reports/:id/export.xlsx      ?p_<name>=&pivot_row=&pivot_col=&pivot_measure=&pivot_aggregation=
                                         → Excel workbook (pivot as a second sheet)
POST   /api/reports/:id/pivot            {row, col?, measure, aggregation, params?} → pivot
POST   /api/reports/:id/chart-preview    {kind, x_column, y_column, series_column?, stacked?, params?} → SVG
POST   /api/reports/:id/run-now          {format?, params?} run an export now → runs row

GET    /api/charts
POST   /api/charts                       {report_id, name, kind, x_column, y_column,
                                          series_column?, stacked?, params?}
GET    /api/charts/:id
DELETE /api/charts/:id
GET    /api/charts/:id/svg               authed SVG
GET    /api/charts/:id/embed             → {chart_id, token, path}

GET    /api/schedules                    with derived next_due_at
PUT    /api/schedules/report/:reportId   {interval, enabled?, format?, params?} — upsert (one per report)
DELETE /api/schedules/:id
POST   /api/schedules/:id/run-now        run this schedule's report now

GET    /api/runs                         ?report_id= → append-only run history (with bound values)

GET    /api/settings                     time zone for relative dates
PUT    /api/settings                     {timezone}  (manage)

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
counts for a known dataset, and for every new kind what a reader takes
from it (grouped and stacked bars summing to their total, a line breaking
at a gap, pie shares, "Other" past eight series, well-formed SVG with
hostile labels); embed token valid/invalid/cross-chart, and an embed
ignoring parameter values in its URL; a schedule/manual run appending
history and writing a CSV whose row count matches the query; parameters
(`test/params.test.ts`) — declarations and SQL agreeing, literals and
comments ignored, values bound so SQL in a value is inert, relative dates
against an injected clock in Vienna, UTC and New York, across year ends
and leap days, a scheduled Excel export of "last month" recording the
dates it bound; the Excel file (`test/xlsx.test.ts`) — every part
validated against ECMA-376, Excel serial reference values, numbers/text/
dates/no formulas; an installation from the previous release
(`test/migration.test.ts`) opening with every row and id kept; the scheduler tick firing a due schedule once (no
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
- **Per-report permissions.** People get `view` / `edit` / `manage` from
  PS-01 (see [Users and access levels](#users-and-access-levels)) — writing
  SQL needs `manage`, running saved reports needs `view` — but a level
  covers every report. Embed URLs are the only unauthenticated surface, and
  each is scoped to a single chart.
- **External cron / distributed scheduling.** The scheduler is in-process
  with no catch-up backfill (documented above). Cron-grade guarantees are
  an extension.
- **Formats beyond CSV and Excel.** Parquet/JSON/PDF exports, Excel
  formulas, formatting beyond a bold header and date cells, and Excel
  charts are out. So are emailed/pushed deliveries (SMTP, S3, webhooks) —
  this module has zero external services.
- **Charts beyond bar/line/area/pie.** Scatter, horizontal bars, dual
  axes, zoom and other interactivity beyond hover titles are an extension
  of the same no-library renderer.
- **Query builder / visual SQL.** Reports are hand-written SELECTs; a
  drag-and-drop query designer is a separate product.
- **Parameters beyond single values.** A parameter is one text, number,
  date or choice; multi-select lists, choices read from a query, and
  parameters that depend on each other are out.

## License

MIT © 0815software — see [LICENSE](LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, report runs are recorded
on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the shared
[`@0815software/platform-clients`](../../platform/clients) package. Best-effort
and opt-in — unset, the module runs standalone. See `server/platform.ts`.

## Users and access levels

Standalone, this module has one login — the local admin — and it manages
everything. With PS-01 Identity wired (`IDENTITY_URL` + `IDENTITY_ORG`), every
person signs in as themselves and gets the level PS-01 grants them here:

| PS-01 permission | Level | May |
| --- | --- | --- |
| `module:reporting-suite:view` | `view` | read everything, change nothing |
| `module:reporting-suite:edit` | `edit` | the day-to-day work: create, update, delete |
| `module:reporting-suite:manage` or `platform:admin` | `manage` | also what `server/access.ts` reserves |

`module:*:<level>` grants a level in every module. Reads need `view`, any other
method needs `edit`. Beyond the method default, [`server/access.ts`](./server/access.ts) names: `POST /api/reports` → `manage`; `PUT /api/reports/:id` → `manage`; `DELETE /api/reports/:id` → `manage`; `POST /api/preview` → `manage`; `POST /api/reports/:id/run` → `view`; `POST /api/reports/:id/pivot` → `view`; `POST /api/reports/:id/chart-preview` → `view`; `PUT /api/settings` → `manage`. A refused request answers **403**
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
