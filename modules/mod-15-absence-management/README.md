# MOD-15 · Absence & Leave Management

> **The point of this module, in one sentence.** A week off costs a different
> number of days in Bayern, in Berlin and in Österreich, and a leave tool that
> does not know that is quietly wrong for somebody on every request.

Annual leave entitlements, absence requests and approvals, counted in **real
working days** against **the employee's own public-holiday calendar** — all
sixteen German Bundesländer plus Austria. Balances are **derived on every
read**; every status change is **append-only**. Single self-contained app —
no external services, no cron, no message broker.

Part of the [0815software module catalogue](../README.md). MIT-licensed,
runs on its own, mirrors the stack and conventions of the other modules.

---

## What it is

One authenticated application with four faces:

- **Requests** — file, approve, reject and withdraw absences. The form shows
  the day count *live*, computed with the same function the server charges
  with, so nobody is surprised by the number afterwards.
- **Balances** — everyone's leave position for a year: base, carry-over,
  lapsed carry-over, taken, pending, remaining, and what remains if
  everything outstanding is approved.
- **Team** — the people, each with a holiday calendar and a start date, and
  a per-year entitlement editor.
- **Calendar** — the twelve-month holiday grid for any region, with a
  compare-with picker that shows exactly which days two regions disagree
  about.

Everything that can be **computed** is computed at read time and never
stored: the cost of a span, every balance figure, and the whole public
holiday calendar.

---

## Stack

- **Client**: Vite + React 19 + TypeScript (strict). Hand-rolled CSS in the
  0815software token system — no UI framework.
- **Server**: Express 5 + better-sqlite3. Stateless HMAC cookie session
  (single admin login, the MOD-03/04 pattern).
- **Tests**: Vitest + Supertest.
- **Zero runtime services.** SQLite file, created and seeded on first run.
  No new dependencies beyond the shared module stack.

Ports: **3015** (API / production server) · **5205** (Vite dev server).
Session cookie: `mod15_session`.

---

## Quickstart

```bash
npm install
npm run dev:api     # http://localhost:3015 — API + seeded SQLite
npm run dev:web     # http://localhost:5205 — Vite dev server, proxies /api
```

Sign in with `admin` / `admin` (local-dev default — change both before
deploying). `npm test` runs the suite; `npm run build && npm start` serves
the built client and the API from one Node process.

---

## The holiday calendar (`shared/calendar.ts`)

The core of the module, and the reason it is a module rather than a form.

Holidays are **computed, never stored**. A table of dates is a table that is
wrong the year nobody remembers to extend it, and the failure is silent:
requests spanning an unlisted holiday quietly cost a day too many and nobody
notices until an employee counts. The rules are stable law, so computing
them is both cheaper and more durable than maintaining data.

- **Easter** via the anonymous Gregorian algorithm; Karfreitag, Ostermontag,
  Christi Himmelfahrt, Pfingstmontag and Fronleichnam are all offsets from
  it.
- **Regional holidays** per Bundesland: Heilige Drei Könige (BW, BY, ST),
  Internationaler Frauentag (BE, MV), Fronleichnam (BW, BY, HE, NW, RP, SL),
  Mariä Himmelfahrt (SL), Weltkindertag (TH), Reformationstag (BB, HB, HH,
  MV, NI, SN, ST, SH, TH) and Allerheiligen (BW, BY, NW, RP, SL).
  Holidays that apply only in **parts** of a state — Fronleichnam in some
  Saxon and Thuringian municipalities, Mariä Himmelfahrt in Catholic Bavarian
  ones — are deliberately left out: they depend on the municipality, not the
  state, and a module that guessed would be wrong for most employees in those
  states.
- **Buß- und Bettag** — the Wednesday before 23 November, Sachsen only —
  is *walked back to the weekday*, not tabulated.
- **Austria** as one region: Heilige Drei Könige, Staatsfeiertag,
  Mariä Himmelfahrt, Nationalfeiertag, Mariä Empfängnis and the rest.
  **Karfreitag is deliberately not there** — it was abolished as a general
  holiday in 2019 and replaced by the *persönlicher Feiertag*, which this
  module models as an absence type (`personal_holiday`) precisely because it
  is not a fixed date.

All arithmetic is date-only and goes through **UTC**, so no deployment's
timezone can shift a holiday onto the day before — the bug that makes a
December stack disagree with a June one.

### What a span costs

```
leaveDays(from, to, region, { halfStart, halfEnd })
```

Working days in the inclusive span, minus half a day for each flagged edge.
A single day flagged half at either end costs **0.5**, not 0. A span made
only of weekends and holidays costs **0** and is refused at 422 — booking it
would put a phantom entry on the team calendar for days the office is shut.

The client imports this same function from `shared/` for its live preview.
A preview computed a second way is a preview that eventually disagrees with
the number the employee is billed, and that argument is unwinnable.

---

## Absence types (`server/absence-config.ts`)

Policy in one file, the MOD-06 / MOD-10 / MOD-14 pattern. Two of the flags
carry legal weight rather than preference:

| Key | Deducts | Needs approval | |
| --- | ------- | -------------- | - |
| `vacation` | yes | yes | the ordinary case |
| `sick` | **no** | **no** | see below |
| `unpaid` | no | yes | no entitlement to draw down |
| `special` | no | yes | Sonderurlaub |
| `personal_holiday` | yes | no | Austria's § 7a ARG replacement for Karfreitag |

**Sick leave does not deduct.** Counting illness against someone's holiday is
unlawful in Germany (**§ 9 BUrlG**) and Austria (**§ 5 UrlG**) — a sick day
falling inside booked leave is even given back. Setting `deducts: true`
there would be a compliance defect, not a configuration choice.

**Sick leave needs no approval.** An approver cannot decline an illness. It
is recorded as a fact that already happened, which is why it lands
`approved` immediately with no approver in the trail.

The file refuses to load a duplicate or blank key, or a list without
`vacation` in it.

---

## Data model

Four tables, migrations applied on boot (`server/db.ts`):

- **`employees`** — name, email, `region`, `started_on`, `left_on`.
  Nobody is ever deleted; leaving sets `left_on` and the record and its whole
  history stay.
- **`entitlements`** — one row per `(employee_id, year)`, unique. Days are
  stored as `base_tenths` / `carry_over_tenths` (see below), plus
  `carry_over_expires_on`.
- **`requests`** — the absence itself: type, span, half-day flags, status,
  note. **No day count column** — see below.
- **`request_events`** — append-only. Every transition, with actor, note and
  timestamp. Nothing here is ever updated or deleted.

### Days are stored as tenths

Everywhere, as integers. Leave comes in halves, and `0.1 + 0.2 !== 0.3` is
not a rounding curiosity when the number is somebody's holiday — a balance
that reads `24.499999999999996` is a support ticket. Integers go into the
database and into every comparison; the division by ten happens once, at the
edge, on the way out.

### What is derived (never stored)

- **A request's day count.** Recomputed from the span and the employee's
  region on every read. Change someone's region and every figure follows;
  there is no stored number to migrate.
- **Every balance figure.** Entitled, taken, pending, remaining and the
  projection are recomputed from the entitlement row and the requests on each
  read. There is no balance column anywhere in this module, so there is
  nothing for a failed job or a manual edit to leave inconsistent.
- **Lapsed carry-over.** Shown separately rather than silently vanishing —
  "you had five days and lost them on 31 March" is the answer somebody is
  going to ask for. Whether it has lapsed is a question about *today*, so
  `today` is injected, never read from the clock inside the maths.
- **The public holidays themselves.**

### Requests spanning new year

Charged to **each year for the days that actually fall in it**. The half-day
flags only apply to the year that owns that edge. This is what both the
employee and a payroll export expect, and it is why the balance query filters
on overlap rather than containment.

---

## Request lifecycle

```
             ┌── approved ──┐
   pending ──┼── rejected   ├── withdrawn
             └──────────────┘
```

- `pending → approved | rejected | withdrawn`
- `approved → withdrawn` — plans change, but that is a withdrawal with its
  own event, never a silent edit
- `rejected` and `withdrawn` are terminal

A decided request never goes back to `pending`. An approver who changes
their mind cancels and the employee books again, which leaves **both** facts
in the trail rather than overwriting the first with the second. Anything
else is **409**.

`withdrawn` and `rejected` are kept apart deliberately: one is the employee
changing their mind, the other is the approver saying no, and a year later
only the distinction explains the pattern.

### What is refused

| Situation | Status |
| --------- | ------ |
| Span is entirely weekend / holiday | **422** |
| Starts before the employee's `started_on` | **422** |
| Starts after the employee's `left_on` | **409** |
| Overlaps an existing `pending` or `approved` request | **409** |
| An illegal transition | **409** |

The overlap check is a read followed by a write, so it runs **inside a
transaction** — two requests submitted at the same instant would otherwise
both find nothing in their way. Two people cannot both be the only one on
the helpdesk on Monday.

**Overdrawing is allowed and shown, not blocked.** Approving past the
entitlement is a management decision (unpaid overdraft, an agreed advance on
next year), and a tool that refuses it just gets worked around in a
spreadsheet. The Balances view flags a negative projection instead.

---

## API reference

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/login` · `/api/logout` | single admin login |
| `GET`  | `/api/health` · `/api/ready` | unauthenticated probes |

Everything below requires the `mod15_session` cookie — else **401**.

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET`  | `/api/config` | absence types + regions + server's today (session probe) |
| `GET`  | `/api/employees?include_left=` | list |
| `POST` | `/api/employees` | `{ name, email, region, started_on }` |
| `GET`  | `/api/employees/:id` | one |
| `POST` | `/api/employees/:id/offboard` | `{ left_on }` — **409** if already left |
| `GET`  | `/api/employees/:id/entitlement?year=` | may be `null` |
| `PUT`  | `/api/employees/:id/entitlement` | `{ year, base_days, carry_over_days?, carry_over_expires_on? }` — upsert |
| `GET`  | `/api/requests?status=&employee_id=&from=&to=` | list (overlap, not containment) |
| `POST` | `/api/requests` | `{ employee_id, type, from_date, to_date, half_start?, half_end?, note? }` |
| `GET`  | `/api/requests/:id` | detail + event trail + the exact days charged |
| `POST` | `/api/requests/:id/approve` · `/reject` · `/withdraw` | `{ note? }` |
| `GET`  | `/api/balances?year=` | everyone, derived |
| `GET`  | `/api/employees/:id/balance?year=` | one, derived |
| `GET`  | `/api/holidays?region=&year=` | the same computation the maths uses |

The three decisions are **verb routes rather than a PATCH of `status`**. A
verb says what happened; a status field only says what is now true, and the
event trail is the point of this module.

Errors are `{ error, details? }`. Validation failures are **422** with a
`details: [{ field, message }]` array.

---

## Configuration

All via environment variables (see `.env.example`); every value has a
local-dev default. The **absence types** are *not* env vars — they are
declarative code config (`server/absence-config.ts`).

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3015` | API / production server port |
| `DATABASE_PATH` | `./data.db` | SQLite file (created automatically) |
| `DEFAULT_REGION` | `DE-BY` | the calendar pre-selected for a new employee |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin` | the single login |
| `SESSION_SECRET` | `dev-secret-change-me` | signs the session cookie |
| `SESSION_TTL_HOURS` | `12` | session lifetime |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |

Numeric settings are **validated, not coerced**: `PORT=808O` (a letter O) or
`SESSION_TTL_HOURS=-1` refuses to boot rather than silently falling back to
a default port nobody is listening on. A blank value still means "unset" —
that is what an uninterpolated compose variable yields.

Change `ADMIN_PASSWORD` and `SESSION_SECRET` before deploying anywhere;
`server/guard.ts` refuses to start in production with the defaults.

---

## Seed data

`npm run seed` (idempotent — skipped if any employee exists) loads four
employees in **four different regions** (Bayern, Berlin, Sachsen, Österreich)
with entitlements and carry-over, plus an approved summer holiday, a pending
short break with a half day at the end, and a sick leave that lands approved
and costs nothing. Everything is built **through the domain functions**, so
the seeded database satisfies the same invariants as a live one.

---

## Deploy notes

`npm run build` compiles the client to `dist/client` and the server to
`dist/server`; `npm start` runs one Node process that serves the API and the
built SPA (client routes fall through to `index.html`). Point a persistent
volume at `DATABASE_PATH`. Put it behind TLS and set `COOKIE_SECURE=true`.
`npm run backup` takes an online, consistent SQLite snapshot.

---

## Out of scope (deliberately)

- **Payroll.** No wage calculation, no Lohnabrechnung export, no ELStAM.
  This module owns days, not money.
- **Time tracking / working hours.** That is [MOD-11](../mod-11-time-tracking).
  A day here is a day, not a number of hours; part-time schedules are handled
  by giving somebody fewer entitlement days, not by modelling a week pattern.
- **Per-employee week patterns** (e.g. never works Fridays). A real
  requirement, and a real amount of maths — it would change what
  `workingDaysBetween` means, so it is a decision, not an afterthought.
- **Multi-user accounts & permissions.** One shared admin login (the
  MOD-03/04 pattern). There is no employee self-service portal: an approver
  files and decides on everyone's behalf.
- **Sick notes / certificates.** No document storage, no AU-Bescheinigung
  handling, no doctor's-note deadline tracking.
- **Sick-day-during-leave restoration.** § 9 BUrlG gives the days back when
  someone falls ill *during* booked leave; this module keeps sick leave from
  deducting at all but does not automatically split an approved holiday
  around it. Withdraw and rebook.
- **Team-coverage rules** ("no more than two people out at once"). Only the
  per-employee overlap check exists.
- **Public holidays outside DE and AT.**
- **Rate limiting / CAPTCHA** — add at the edge.

---

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records
employee, entitlement and decision changes on
[PS-07 Audit Log](../../platform/ps-07-audit-log) via the shared
[`@0815software/platform-clients`](../../platform/clients) package (it can
also send via PS-03 when `NOTIFICATION_URL` is set). When `IDENTITY_URL` is
set, logins are verified against [PS-01 Identity](../../platform/ps-01-identity)
instead of the local pair. All best-effort and opt-in — unset, the module
runs standalone. See `server/platform.ts` and `server/sso.ts`.

---

MIT © 2026 0815software. See [LICENSE](./LICENSE).
