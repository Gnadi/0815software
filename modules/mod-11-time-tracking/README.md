# MOD-11 · Time Tracking

Project allocation, daily entry, weekly approval, and export to payroll
or billing. Works offline. Part of the
[0815software](https://0815software.com) module catalogue — standard
business software, MIT-licensed, always free.

Three correctness properties are the point of this module, and the test
suite proves each of them:

1. **Time is integer minutes; money is derived, never stored.** A time
   entry stores a positive integer number of minutes (a CHECK forbids
   0/negative and caps one entry at 24h). The billable amount is always
   recomputed as `round(minutes × rate_cents ÷ 60)` from the project's
   current rate by one shared function — so hours, amounts and rollups
   can never drift. Money is computed from **exact minutes**, not from
   the 2-decimal hours shown to payroll, so display rounding never leaks
   into a billed figure.
2. **A day cannot exceed 24 hours.** The sum of all of one
   (employee, date)'s entries is capped at 1440 minutes; the check runs
   in a transaction across every entry, so it holds no matter how the
   minutes are split up.
3. **Approved weeks are locked.** Entries roll up into a per-(employee,
   week) timesheet with a `draft → submitted → approved` lifecycle. Once
   a week is approved, any insert/edit/delete touching it is a 409;
   rejecting a submitted week returns it to draft and records the reason.
   Every transition writes an append-only status event (who / when /
   note).

## Stack

Deliberately standard and boring (identical to MOD-01 … MOD-10):

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Export   | Hand-rolled declarative CSV — zero deps       |
| Styling  | Hand-rolled CSS, no framework                 |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`.
That's all — no CDN, no external services, no telemetry.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-11-time-tracking
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3011
npm run dev:api

# terminal 2 — UI on :5201 (proxies /api to :3011)
npm run dev:web
```

Open http://localhost:5201 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3011
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Data model

Six tables, no stored derived state:

```
projects          name, client, billable_default, rate_cents, active   (CRUD via UI/API)
tasks             project, name, active                                (optional, per project)
employees         name, email                                          (a simple list; no login)
time_entries      employee, project, task?, entry_date, minutes,
                  billable, note                                       (minutes = positive integer)
timesheets        employee, week_start (Monday), status                (one row per touched week)
timesheet_events  employee, week_start, action, from/to status,
                  actor, note                                          (append-only history)
```

**Minutes** are integer everywhere; hours only exist at the rendering
edge (`1:45` in the grid, `1.75` in a payroll export). The billable
amount of an entry is derived:

```
billable_cents = billable ? round(minutes × rate_cents ÷ 60) : 0
```

with `round()` half-away-from-zero (`Math.round`). The division is done
on the integer product `minutes × rate_cents`, so a 7-minute entry at
€90/h is `round(7 × 9000 ÷ 60) = round(1050) = 1050` cents — never a
figure derived from truncated decimal hours. Project / employee / day /
week rollups are all derived by query from the entries.

## Rounding & approval rules

- **Duration input** accepts `90` (minutes), `1:30` (h:mm), `1.5` /
  `1,5` (decimal hours) or `90m` / `1.5h`; everything is stored as whole
  minutes.
- **Daily cap**: the total of all entries for one (employee, date) may
  not exceed 1440 minutes (24h); a single entry may not exceed 1440
  either. Violations are `422`.
- **Weekly lifecycle**: `draft → submitted → approved`. A week is the
  Monday–Sunday window (`week_start` is the Monday). Submitting requires
  at least one entry. Only a draft can be submitted, only a submitted
  week can be approved or rejected — anything else is a `409`.
- **Approval locks the week.** While a week is `approved`, inserting,
  editing or deleting any entry in it (or moving an entry into/out of it)
  is a `409`. **Rejecting** a submitted week sets it back to `draft` and
  appends a `reject` event with the reviewer's note — so the entries are
  editable again and the rejection is on record. (Approved is terminal
  in this build: to change an approved week, reject is not available —
  reopen support is intentionally out of scope; see below.)
- **Audit trail**: every submit/approve/reject writes a
  `timesheet_events` row (`actor` = the admin username, timestamp, and
  optional note). These rows are never updated or deleted.

## Export profiles

"Export to payroll or billing" is kept honest by making formats **data,
not code**. A profile lives in [`server/export-profiles.ts`](server/export-profiles.ts):
a name, a **scope** (which decides what one CSV row is) and a column
list; each column is a header plus a field from that scope's documented
set and an optional money / hours / date format. The render engine in
[`server/csv.ts`](server/csv.ts) never changes to add a profile.

Three profiles ship:

| Profile   | Scope    | One row per | Purpose                                                        |
| --------- | -------- | ----------- | -------------------------------------------------------------- |
| `PAYROLL` | employee | employee    | Decimal hours per person (total / billable / non-billable).    |
| `BILLING` | project  | project     | Billable amount per project & client (euro amounts).           |
| `DETAIL`  | entry    | time entry  | Full audit dump: date, employee, project, task, minutes, etc.  |

Export is by inclusive date range and profile:

```
GET /api/export/timesheets.csv?profile=PAYROLL&from=2026-06-01&to=2026-06-30
```

Output is RFC-4180-style CSV with CRLF line endings and a header row.
Money and hours are formatted per column: money as `cents`,
`decimal-dot` (`1234.56`) or `decimal-comma` (`1234,56`); hours as `dot`
(`1.75`) or `comma` (`1,75`); dates as `iso`, `dmy-dot` or `ymd-compact`.
The export covers **every entry in the range regardless of approval
status** — approval is a separate control you run in the Timesheets view.

### Adding a profile

1. Add an entry to `EXPORT_PROFILES` in `server/export-profiles.ts`:
   pick a `scope`, then list `columns` — each a `header`, a `field` from
   `SCOPE_FIELDS[scope]`, and an optional `money` / `hours` / `date`
   format.
2. That's it. The config self-check (which runs on import) rejects
   unknown fields and mis-applied formats, and the render engine and UI
   pick the profile up automatically. Add a test asserting its header
   row and a formatted value.

## "Works offline" — what it means (and doesn't)

This app is **local-first by construction**: it talks only to its own
SQLite file, ships its own CSS, and uses a system font stack — there is
no CDN, analytics, or third-party call anywhere. Once the page has
loaded it needs no network to browse and compute (rollups and amounts
are derived client-and-server-side from the same shared code).

On top of that, the daily-entry grid keeps your **in-progress row** in
`localStorage`: if you reload or the tab crashes mid-typing, the project,
duration and note you had entered are restored. The draft is cleared once
the entry is saved.

What it is **not**: there is no Service Worker and no full PWA/offline
install. The API is a normal server — if you close the laptop lid on the
train, you can keep *typing* a row (it's held locally) but you can't
*save* it until the API is reachable again. A true offline-sync build
(background sync, conflict resolution) is a different, larger project and
is intentionally out of scope.

## Features

- **Daily Entry** — pick an employee and a day, add rows fast (flexible
  duration input, live billable-amount preview, per-day total and
  remaining-to-cap). Approved days are read-only. The in-progress row is
  saved locally.
- **Timesheets** — per-employee list of weeks with status and totals;
  submit / approve / reject with a per-week detail (per-project rollup +
  append-only history).
- **Summary** — per-project and per-employee rollups over any date
  range, all derived by query.
- **Export** — range + profile → CSV download (payroll / billing /
  detail).
- **Projects & Tasks** — CRUD with billable default and hourly rate;
  optional tasks; archive instead of delete once entries exist.
- **Employees** — a simple name/email list.
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, optional Secure), exactly as in
  MOD-02/03/04.

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                | Purpose                             |
| ------------------- | ---------------------- | ----------------------------------- |
| `PORT`              | `3011`                 | API / production server port        |
| `DATABASE_PATH`     | `./data.db`            | SQLite file (created on demand)     |
| `ADMIN_USERNAME`    | `admin`                | Login user                          |
| `ADMIN_PASSWORD`    | `admin`                | Login password — **change in prod** |
| `SESSION_SECRET`    | `dev-secret-change-me` | HMAC key for the session cookie     |
| `SESSION_TTL_HOURS` | `12`                   | Session lifetime                    |
| `COOKIE_SECURE`     | `false`                | Set `true` behind HTTPS             |

The server prints a warning on startup while the default password is in
use. The dev server does not load `.env` files by itself — export the
variables in your shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except for
`POST /api/login` and `GET /api/health`. Time in/out is integer minutes;
money is integer cents.

```
POST   /api/login                       {username, password} → session cookie
POST   /api/logout
GET    /api/me

GET    /api/projects                    ?active=1 → active only
POST   /api/projects                    {name, client?, billable_default?, rate_cents?, active?}
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id                409 if the project has entries (archive instead)
POST   /api/projects/:id/tasks          {name}
PUT    /api/tasks/:id                    {name, active?}
DELETE /api/tasks/:id                    409 if the task has entries

GET    /api/employees
POST   /api/employees                    {name, email?}
GET    /api/employees/:id
PUT    /api/employees/:id
DELETE /api/employees/:id                409 if the employee has entries

GET    /api/day                          ?employee_id=&date= → day grid + totals
POST   /api/entries                      {employee_id, project_id, task_id?, entry_date,
                                          minutes, billable?, note?}   422 on bad minutes / over-cap
GET    /api/entries/:id
PUT    /api/entries/:id                   409 if the (old or new) week is approved
DELETE /api/entries/:id                   409 if the week is approved

GET    /api/timesheets                    ?employee_id= → week rows with status + totals
GET    /api/timesheets/:employeeId/:weekStart   week detail (entries, rollup, events)
POST   /api/timesheets/submit             {employee_id, week_start}  draft → submitted
POST   /api/timesheets/approve            {employee_id, week_start, note?}  submitted → approved
POST   /api/timesheets/reject             {employee_id, week_start, note?}  submitted → draft

GET    /api/summary                       ?from=&to= → per-project & per-employee rollups
GET    /api/export/profiles               the declared CSV profiles
GET    /api/export/timesheets.csv         ?profile=&from=&to= → CSV download
```

Validation failures return `422` with `{error, details: [{field,
message}]}`; state conflicts (editing an approved week, submitting a
non-draft) return `409`; a missing resource is `404`; no session is
`401`.

## Scripts

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` proxy                       |
| `npm run seed`    | Create/seed the SQLite database (skips non-empty DBs)   |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | Invariant + API tests (Vitest, in-memory SQLite)        |

The tests prove the properties that matter: integer-minute validation
(0 / negative / fractional rejected), the 24h/day cap enforced across
several entries, billable rounding at the boundary (7-minute and
90-minute cases), derived rollups vs. hand-computed fixtures,
approved-week immutability (409), the reject→draft path recorded in the
history, each export profile's header and formatted values, the
project/employee delete guards (409), and 401 without a session.

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`) and `COOKIE_SECURE=true`, and terminate TLS in
  front (Caddy/nginx).
- Not a fit for serverless platforms: SQLite wants a persistent
  filesystem.

## Out of scope

Kept out deliberately to stay a 2–3 week module. If you need any of
these, that's commissioned work — exactly the kind 0815software does:

- **Per-employee login and self-service entry** — this is a single-admin
  tool (same auth pattern as MOD-02/03/04); one staff user enters and
  approves time. No employee accounts, no roles, no "my timesheet".
- **A running timer / punch clock** — you enter durations, you don't
  start/stop a stopwatch.
- **Full offline PWA / background sync** — the app is local-first and
  keeps an in-progress row locally, but there is no Service Worker and no
  offline write queue (see the "Works offline" section).
- **Reopening an approved week** — approval is a lock; corrections to an
  approved period are a policy decision left to you (delete the DB row or
  add a reopen endpoint).
- **Overtime, leave, holidays, multi-currency, tax** — minutes and one
  euro rate per project only.
- **Invoice / payroll generation** — this module *exports* CSV for those
  systems (feed BILLING into MOD-04, PAYROLL into your payroll); it does
  not produce invoices or payslips itself.

## License

MIT © 0815software — see [LICENSE](LICENSE).
