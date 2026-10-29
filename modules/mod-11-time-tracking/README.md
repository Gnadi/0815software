# MOD-11 · Time Tracking

Project allocation and planning (board, milestones, estimates), daily
entry, weekly approval, absences (vacation, sick leave, holidays),
flexitime and overtime, and export to payroll or billing. Works offline. Part of the
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
4. **Leave days and balances are derived, never stored.** What a request
   costs is counted from its dates, the person's work days and the
   holiday calendar; the vacation balance is the entitlement ledger minus
   approved vacation. Change the calendar or a part-timer's days and every
   figure follows. See [Absences](#absences).
5. **The flexitime balance is derived, never stored.** Each day asks for
   its share of the person's weekly hours, the balance is worked minus due
   plus an append-only ledger (opening balance, corrections, overtime paid
   out). Working-time models are dated, so a change of contract never
   re-prices the past. See [Flexitime and overtime](#flexitime-and-overtime).
6. **Planning stores decisions, derives the rest.** Where a task stands,
   who does it, by when and its estimate are stored; spent, remaining,
   overdue, a milestone reached and a project's hours against its budget
   are derived from the time booked and the date. Every move on the board
   is an append-only event. See [Planning](#planning).

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

Fourteen tables, no stored derived state:

```
projects          name, client, billable_default, rate_cents, active,
                  budget_minutes?                                      (CRUD via UI/API)
tasks             project, name, active, status, assignee?, due_date?,
                  estimate_minutes?, milestone?, description?          (optional, per project)
milestones        project, name, due_date                              (reached is derived)
task_events       task, from/to status, actor, note                    (append-only history)
employees         name, email                                          (email = the person's login)
work_schedules    employee, valid_from, weekly_minutes?, work_days     (append-only, one row per change)
flex_entries      employee, kind, minutes, effective_date, note, actor (append-only ledger)
time_entries      employee, project, task?, entry_date, minutes,
                  billable, note                                       (minutes = positive integer)
timesheets        employee, week_start (Monday), status                (one row per touched week)
timesheet_events  employee, week_start, action, from/to status,
                  actor, note                                          (append-only history)
leave_requests    employee, type, start/end, half_day, status,
                  created_by, decided_by, decision_note                (no day count stored)
leave_events      request, type, actor, note                           (append-only history)
leave_entitlements employee, year, kind, days, note, actor             (append-only ledger)
leave_settings    country, extra holidays, flexitime cap/floor,
                  daily maximum                                        (one row, admin-maintained)
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

- **My Area** — the signed-in person's own week and last week, flexitime
  balance, leave left, pending requests and next due tasks, with the timer
  on top; each figure is the one its own screen shows.
- **Timer** — start on a project (and task), stop into an ordinary entry;
  runs on the server. See [The timer](#the-timer).
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
- **Projects & Tasks** — CRUD with billable default, hourly rate and an
  optional budget in hours; optional tasks; archive instead of delete once
  entries exist. Each project has a **board** (to do → in progress →
  review → done) with assignees, due dates, estimates and milestones.
- **My Tasks** — what is assigned to the signed-in person, soonest due
  first, moved from the same list.
- **Absences** — request vacation and other leave, record sick leave,
  approve or reject (manage), the year's balance, a team calendar per
  month, and the holiday calendar (AT or DE plus company days).
- **Flexitime** — the balance, overtime above the cap, month by month
  and day by day, the bookings (opening balance, corrections, overtime
  paid out), the team overview and a monthly CSV for payroll.
- **Employees** — name, login email, the working-time model from a date
  on, and the vacation entitlement ledger per year.
- **Auth** — a local admin login from env vars, or sign-in through PS-01
  with per-person access levels; stateless HMAC-signed session cookie
  (HttpOnly, SameSite=Lax, optional Secure).

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
| `NOTIFICATION_URL`  | —                      | PS-03 Notification Hub: send the reminders switched on in Settings |
| `REMINDER_TICK_SECONDS` | `300`              | How often the reminder tick looks for what is due (30–86400) |

The server prints a warning on startup while the default password is in
use. The dev server does not load `.env` files by itself — export the
variables in your shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except for
`POST /api/login` and `GET /api/health`. Time in/out is integer minutes;
money is integer cents.

```
POST   /api/login                       {username, password} → session cookie
GET    /api/auth-mode                   local or SSO — which credentials to name
POST   /api/logout
GET    /api/me

GET    /api/projects                    ?active=1 → active only
POST   /api/projects                    {name, client?, billable_default?, rate_cents?, active?}
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id                409 if the project has entries (archive instead)
POST   /api/projects/:id/tasks          {name}
PUT    /api/tasks/:id                    {name, active?}
DELETE /api/tasks/:id                    409 if the task has entries or has moved on the board
GET    /api/tasks/:id                    task + its moves
PUT    /api/tasks/:id/plan               {assignee_id?, due_date?, estimate_minutes?, milestone_id?, description?}  (manage)
POST   /api/tasks/:id/status             {status: todo|in_progress|review|done, note?}  assignee or manage
GET    /api/projects/:id/board           progress, milestones, active tasks with derived figures
POST   /api/projects/:id/milestones      {name, due_date}  (manage)
PUT    /api/milestones/:id               {name, due_date}  (manage)
DELETE /api/milestones/:id               its tasks stay, without a milestone  (manage)
GET    /api/portfolio                    ?archived=1 → every project: spent, budget, estimate, tasks per status
GET    /api/my-tasks                     ?done=1 → the signed-in person's tasks

GET    /api/employees
POST   /api/employees                    {name, email?, work_days?}   work_days "12345" = Mon–Fri
GET    /api/employees/:id
PUT    /api/employees/:id
DELETE /api/employees/:id                409 if the employee has entries or leave on record
GET    /api/employees/:id/entitlements    ?year= → the ledger
POST   /api/employees/:id/entitlements    {year, kind: allowance|carryover|adjustment, days, note?}  (manage)
GET    /api/employees/:id/schedules       the working-time models, oldest first
POST   /api/employees/:id/schedules       {valid_from, weekly_minutes|null, work_days, note?}  (manage)
GET    /api/employees/:id/flex-entries    the flexitime ledger
POST   /api/employees/:id/flex-entries    {kind: opening|adjustment|payout, minutes, effective_date?, note?}  (manage)

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

GET    /api/leave/requests                ?employee_id=&year=&status=&to_decide=1
POST   /api/leave/requests                {employee_id?, type, start_date, end_date?,
                                           half_day?, note?}  without employee_id: your own
GET    /api/leave/requests/:id            request + its history
POST   /api/leave/requests/:id/approve    {note?}   manage, never one's own
POST   /api/leave/requests/:id/reject     {note}    manage, never one's own; says why
POST   /api/leave/requests/:id/withdraw   own or manage; approved leave only before it begins
GET    /api/leave/balance                 ?employee_id=&year= → entitled/taken/pending/remaining/free
GET    /api/leave/calendar                ?month=YYYY-MM → days (with holidays) × people
GET    /api/leave/holidays                ?year= → statutory + company days
GET    /api/leave/settings
PUT    /api/leave/settings                {country: AT|DE, extra_holidays: [{date, name}],
                                           flex_cap_minutes, flex_floor_minutes, daily_max_minutes}  (manage)

GET    /api/my-overview                   the signed-in person's week, last week, flexitime, leave, tasks, timer

GET    /api/timer                         ?employee_id= → the running timer or null (own without employee_id)
POST   /api/timer/start                   {employee_id?, project_id, task_id?, note?, billable?}  stops a running one first
PUT    /api/timer                         {employee_id?, project_id, task_id?, note?, billable?}  what it is for, clock unchanged
POST   /api/timer/stop                    {employee_id?, stopped_at?} → {entry, minutes, capped, discarded}
POST   /api/timer/discard                 {employee_id?}  nothing booked
GET    /api/timers                        everyone on the clock now  (manage)
GET    /api/settings/timer                time zone, PS-03 channel, reminders
PUT    /api/settings/timer                {timezone, channel, week_reminder: {enabled, weekday, hour},
                                           timer_reminder: {enabled, after_minutes}}  (manage)
GET    /api/reminders                     sent (latest 100) and due now  (manage)
POST   /api/reminders/run                 send what is due now  (manage; 501 without NOTIFICATION_URL)

GET    /api/flex/account                  ?employee_id=&as_of= → balance, overtime, months  (own without employee_id)
GET    /api/flex/days                     ?employee_id=&month=YYYY-MM → each day: target, due, worked, diff
GET    /api/flex/overview                 everyone with an account, as of today
GET    /api/export/flex.csv               ?month=YYYY-MM → per person: due, worked, paid out, balance, overtime
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

- **Delegates and team leads** — below `manage` a person records only their
  own time (see [Own time only](#own-time-only)); "may record for my team" is
  not a level, and would be an extension of `server/ownership.ts`.
- **A punch clock** — the timer books time to projects; there is no
  separate clock-in/clock-out record of attendance, no terminal, no
  geofencing, and breaks are not deducted automatically.
- **Reminders beyond the two** — last week not submitted and a timer left
  running; no daily "you booked nothing today", no digest for managers.
- **Full offline PWA / background sync** — the app is local-first and
  keeps an in-progress row locally, but there is no Service Worker and no
  offline write queue (see the "Works offline" section).
- **Reopening an approved week** — approval is a lock; corrections to an
  approved period are a policy decision left to you (delete the DB row or
  add a reopen endpoint).
- **Multi-currency, tax** — minutes and one euro rate per project only.
- **Overtime pay and labour-law checks** — overtime is counted and paid
  out in hours; the surcharge (AZG § 10: 50 %) is payroll's. Nothing
  forfeits or converts a balance at a period end on its own — that is the
  office's booking. Breaks and rest periods are not checked; days above the
  daily maximum are only flagged.
- **Regional holidays by rule** — the calendar knows Austria's statutory
  days and Germany's nine nationwide ones; a Land's own days (e.g.
  Fronleichnam in Bavaria) or 24/31 December are entered as company days.
- **Leave beyond the basics** — no expiry of carried-over days, no
  accrual by month, no sick notes (Krankmeldung uploads), no notification
  e-mails, no deputy rules.
- **Planning beyond the basics** — no Gantt chart or task dependencies,
  no resource levelling or capacity view against the working-time models,
  no sub-tasks, checklists, comments or attachments on a task, and no
  estimate taken from an offer: an offer's lines have no unit, so hours
  would be invented (see the offer import below).
- **Invoice / payroll generation** — this module *exports* CSV for those
  systems (feed BILLING into MOD-04, PAYROLL into your payroll); it does
  not produce invoices or payslips itself.

## License

MIT © 0815software — see [LICENSE](LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records key
state changes on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the
shared [`@0815software/platform-clients`](../../platform/clients) package.
Calls are best-effort and opt-in — unset, the module runs standalone. See
`server/platform.ts`.

## Users and access levels

Standalone, this module has one login — the local admin — and it manages
everything. With PS-01 Identity wired (`IDENTITY_URL` + `IDENTITY_ORG`), every
person signs in as themselves and gets the level PS-01 grants them here:

| PS-01 permission | Level | May |
| --- | --- | --- |
| `module:time-tracking:view` | `view` | read everything, change nothing |
| `module:time-tracking:edit` | `edit` | the day-to-day work: create, update, delete |
| `module:time-tracking:manage` or `platform:admin` | `manage` | also what `server/access.ts` reserves |

`module:*:<level>` grants a level in every module. Reads need `view`, any other
method needs `edit`. Beyond the method default, [`server/access.ts`](./server/access.ts) reserves approving and rejecting weeks, deciding leave, granting entitlements, the holiday calendar, working-time models and flexitime bookings, planning tasks (assignee, due date, estimate, milestone) and milestones, maintaining employees, projects and tasks (including importing an offer as a project), and who is on the clock, the time zone and the reminders, for `manage`. A refused request answers **403**
`{ error, required, access }`; `GET /api/me` reports the caller's `access`.
Setting `IDENTITY_PERMISSION` restores the old rule (one permission, which
manages). The contract is in [`docs/ACCESS-LEVELS.md`](../../docs/ACCESS-LEVELS.md).


### Own time only

Below `manage`, a person writes only their OWN time: the employee whose
`email` is the identity they signed in with (compared case-insensitively).
Creating, changing, moving or deleting an entry and submitting a week are all
held to that in [`server/ownership.ts`](./server/ownership.ts) — the one rule
here that depends on the row rather than the route, so it is one function the
entry routes call, not checks spread through them. Someone whose email no
employee carries is told so (**403**) rather than shown a colleague's sheet.
`GET /api/me` reports `employee_id`, and the daily and weekly screens open on
it and stay there for an editor. A manager records and corrects anyone's time.
`test/ownership.test.ts` pins every case.

## Absences

Absences live here, next to the time they replace, not in a module of their
own. Types: vacation, sick leave, special leave, unpaid leave, comp time.

- **Requesting.** An editor requests leave for themselves (the same
  ownership rule as time, `server/ownership.ts`); a manager for anyone. A
  request covers whole days or one half day, stays within one calendar year
  (each year has its own allowance), and may not overlap another open or
  approved one.
- **Deciding.** Only `manage` approves or rejects, and **never their own
  request** — a manager's leave is decided by another manager. A rejection
  says why. Approval re-checks the balance, since another request may have
  been approved in between.
- **Sick leave** is reported, not asked for: it stands approved as it is
  recorded. Only the person and managers see that it is sickness; everyone
  else sees `absent` in lists and the calendar. Health data is special
  category data (GDPR Art. 9) — see `docs/PII-MAP.md`.
- **Withdrawing.** A request can be withdrawn while open; approved leave
  only before its first day. Leave that has begun was taken and stays.
- **Days are derived.** `server/leave.ts:workingDays` counts the work days
  of the schedule on each date in the range, minus holidays; nothing stores
  a day count. The
  holidays come from `shared/holidays.ts` (Austria: the 13 days of Feiertagsruhegesetz
  § 7; Germany: the nine nationwide
  days; Easter by the Gregorian computus) plus the company days a manager
  enters.
- **The balance is derived.** Entitled = the sum of the year's ledger
  (allowance, carry-over, ± corrections — rows are added, never edited);
  taken = approved vacation days; free = entitled − taken − pending.
- **Nobody with leave on record is deleted** — the history would lose its
  subject.

Pinned by `test/leave.test.ts` (costs, part-time, calendar settings,
balance and re-check, overlap and year split, who may do what, withdraw,
delete guard, sick-leave masking, team calendar) and `test/holidays.test.ts`
(Easter dates and the full AT/DE lists for 2025 and 2026).

## Planning

Projects and tasks were already here as what time is booked against; they are
planned here too, so there is one project list, and the hours booked are the
hours a plan is measured against. (A separate project module would have had to
keep its list in step with this one.)

- **The board.** A task is to do, in progress, in review or done. The
  person it is assigned to moves it (`edit`); a manager moves any. Who does
  it is the manager's decision, so a colleague cannot take over a task by
  moving it (`mayMoveTask`, `server/ownership.ts`). Every move is a
  `task_events` row with the person; a task or project that has moved is
  never deleted — deactivate or archive it.
- **The plan** — assignee, due date, estimate, milestone, description — is
  set by `manage`. A milestone of another project is refused.
- **Derived:** spent = the minutes booked against the task; remaining =
  estimate − spent (never below zero); over estimate; overdue = past the due
  date and not done. A milestone is **reached** when every active task on it
  is done (one with no tasks is not), and **late** when its date passes
  first. A project's spent counts every minute booked on it, with or without
  a task, against its budget; its estimate is the sum of its tasks'.

Pinned by `test/planning.test.ts` (planning and its refusals, the budget,
who moves what and the event trail, deactivated tasks, spent and remaining,
overdue, milestones reached and late, the portfolio figures, my tasks, kept
history, and an existing database gaining the columns in place).

## The timer

A start/stop clock that writes ordinary time entries (`server/timer.ts`):

- **On the server.** A running timer is a row (`timers`, one per person):
  it survives a reload, a closed tab and a switch of device. How long it
  has run is derived from `started_at`, never stored.
- **One per person.** Starting another stops the running one first, in the
  same transaction.
- **The stop is an entry like any other** — the daily cap, an approved week
  staying locked (the stop is refused with 409 and the timer kept, to be
  discarded), own time only below `manage` (`server/ownership.ts`). The
  entry keeps `timer: {started_at, stopped_at, capped}`; the daily grid
  marks it ⏱.
- **Local days.** The entry is dated the day the timer started where the
  people work — the time zone in Settings (`Europe/Vienna` by default).
- **A forgotten timer is capped, and says so**: at local midnight of the day
  it started and at the daily maximum (`daily_max_minutes`, the ten hours of
  AZG / ArbZG, from the calendar settings). A person who forgot may also
  say when they finished (`stopped_at`: not before the start, not in the
  future).
- **Under a minute books nothing** — the log line stays.
- Every start, stop and discard is logged with the person (`timer_events`).

**Reminders** (`server/reminders.ts`) go through PS-03 — with
`NOTIFICATION_URL` set, and each kind switched on in Settings (`manage`):
*last week not submitted*, from a weekday and hour (local), to whoever
still has it as a draft and booked time or had a weekly target; and *timer
still running* after a set time. Each goes once per person and occasion
(`reminders_sent`, and PS-03's idempotency key); a failed send is tried on
the next tick. The tick runs in-process every `REMINDER_TICK_SECONDS` while
the server is up; *Send due now* runs it at once.

**My area** (`server/my-area.ts`) puts the person's own figures on one
screen; each comes from the function its own screen reads, so they can
never disagree.

Pinned by `test/timer.test.ts` (start/stop/entry, one per person, under a
minute, the local day across the clock change, the midnight and daily
caps, the stop time, the locked week, own only, editing a running timer,
the time zone), `test/reminders.test.ts` (who is reminded and who not, the
weekday and hour, once, failure and retry, standalone, the running timer,
the office's routes) and `test/my-area.test.ts` (the figures against their
own screens' functions, own only, no flexitime account).

## Flexitime and overtime

- **Working-time models.** A manager gives a person a schedule from a date
  on: weekly hours and work days. A change of contract is a new row from
  its date — never an edit — so last year's leave and flexitime keep their
  price. Without a schedule a person works Monday to Friday and has no
  flexitime account; a schedule without weekly hours sets only the days.
- **What a day asks for.** The weekly hours spread over the work days;
  minutes that do not divide go one each to the first days, so a week adds
  up exactly (37.5 h on four days: 9:23, 9:23, 9:22, 9:22). Holidays and
  days off ask for nothing.
- **Absences cover the day.** Approved vacation, sick, special and unpaid
  leave credit the day's target (a half day half of it). **Comp time does
  not** — it is a day off paid for with the balance.
- **The balance is derived.** From the first day with a target:
  Σ (worked − due) plus the ledger rows up to that date. Worked is every
  entry, approved week or not. Saturday's work counts in full.
- **Overtime** is the balance above the cap in the settings (default 40 h;
  the floor −20 h; the daily maximum 10 h — the shape of a common
  flexitime agreement, AZG § 4b / Betriebsvereinbarung, not law, so the
  office sets them). A payout takes hours out of the account and is
  refused beyond what is in it; the monthly CSV gives payroll the hours.
- **Only the office books** what the days cannot say: an opening balance,
  a correction (which says why), a payout. People see their own account;
  sick days show as `absent` to colleagues here too.

Pinned by `test/flextime.test.ts` (target distribution, balance, holidays,
absence credit and comp time, schedule changes, daily maximum, cap and
payout, floor, who may book, own account, payroll CSV, team overview) and
the part-time case in `test/leave.test.ts`.

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

## Planning an accepted offer as a project

`POST /api/projects/import-offer` takes an offer number, fetches it from MOD-13
over `OFFERS_URL` as a neutral document transfer (`shared/transfer.ts`), and
creates a project with **one task per offer line** — so hours land against the
thing that was sold rather than in one bucket somebody untangles later. The
Workspace puts a **PLAN WORK** button on the accepted-offers widget that calls
this route as the person who clicked.

**The money deliberately stays behind.** A project's `rate_cents` is what an
*hour* costs; an offer's total is what the *job* costs, and the offer does not
say how many hours are in it — a fixed-price one may have no answer at all. An
imported project therefore starts at a rate of zero for someone to set, because
a number that looks authoritative and is invented would be inherited by every
billable-hours total afterwards.

**It refuses a pipeline deal.** The same transfer shape can carry one, and
staffing a project for work the customer has not agreed to buy is how a team
ends up having booked real hours against a job that never happens.

It is idempotent on the offer number: a second import returns the first
project, because one job's hours split across two projects is a mistake nobody
notices until billing. With `OFFERS_URL` unset — the standalone default — the
route answers `501` and says which variable is missing. See
[`docs/SHELL-CONTRACT.md`](../../docs/SHELL-CONTRACT.md).
