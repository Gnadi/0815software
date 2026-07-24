# MOD-14 · Subsidies & Funds

> **Perspective — read this first.** This module is built entirely from the
> **applicant / recipient** point of view. "We" are a company that discovers
> public and private **funding programs** ("Förderungen" in the DACH sense),
> **applies** to them, gets some **approved**, receives the money in
> **tranches (disbursements)**, and then owes **post-award reports**. Money
> flows **toward us**. This is **not** a grantor/administrator tool — it does
> not distribute money to third parties, score applicants, or manage a
> funding budget. It tracks *our* pipeline of applications and *our*
> obligations.

Track funding programs you can apply to, your own applications through a
config-driven approval lifecycle, the funds actually disbursed to you (as
append-only tranches with a **derived** remaining balance), and your
post-award reporting deadlines (**derived** from an injectable clock).
Single self-contained app — no external services, no cron, no message broker.

Part of the [0815software module catalogue](../README.md). MIT-licensed,
runs on its own, mirrors the stack and conventions of the other thirteen
modules.

---

## What it is

One authenticated application with four faces:

- **Deadlines** — a single derived dashboard combining upcoming application
  deadlines of programs still open, our outstanding reporting obligations
  (overdue / at-risk / upcoming), and the portfolio money totals.
- **Programs** — the funding programs we can apply to (CRUD), each with a
  funding rate, a grant ceiling, a category and an optional deadline.
- **Applications** — the core workflow: our applications through
  `draft → submitted → under_review → approved / rejected / withdrawn`, with
  an append-only status timeline, disbursement tranches and reporting
  obligations.
- **Portfolio** — requested vs approved vs disbursed vs remaining across all
  applications, plus a CSV export.

Everything that can be **computed** is computed at read time and never
stored: an application's funding cap, its disbursed total and remaining
balance, and every deadline verdict. Nothing that can drift is written down.

---

## Stack

- **Client**: Vite + React 19 + TypeScript (strict). Hand-rolled CSS in the
  0815software token system — no UI framework.
- **Server**: Express 5 + better-sqlite3. Stateless HMAC cookie session
  (single admin login, the MOD-03/04 pattern).
- **Tests**: Vitest + Supertest.
- **Money** is integer cents everywhere (MOD-04 discipline); euros exist only
  at the rendering edge.
- **Zero runtime services.** SQLite file, created and seeded on first run. No
  new dependencies beyond the shared module stack.

Ports: **3014** (API / production server) · **5204** (Vite dev server).
Session cookie: `mod14_session`.

---

## Quickstart

```bash
npm install
npm run seed          # optional — the server also seeds an empty DB on first boot
npm run dev:api       # API on http://localhost:3014
npm run dev:web       # Vite UI on http://localhost:5204 (proxies /api → 3014)
```

Open <http://localhost:5204> and sign in with the local-dev default
`admin` / `admin`.

Production build (single process serves API + built client):

```bash
npm run build
npm start             # http://localhost:3014
```

```bash
npm test              # Vitest + Supertest
```

---

## Data model

Four content tables plus a per-year counter. **Rows store only facts;
balances and verdicts are derived.**

```
programs              id, name, funding_body, category, description,
                      funding_rate (0–100 %), max_grant_cents, currency,
                      application_deadline (nullable = rolling), status,
                      created_at
applications          id, ref (unique), program_id, title, status,
                      eligible_costs_cents, requested_amount_cents,
                      approved_amount_cents (set on approval),
                      submission_date, reference, notes, created_at
application_events    id, application_id, type, from_status, to_status,
                      actor, note, approved_amount_cents, created_at
disbursements         id, application_id, disbursed_on, amount_cents,
                      reference, note, created_at
obligations           id, application_id, title, due_date, done, done_at,
                      created_at
application_counters  year, last_seq          -- assigns APP-<year>-<seq>
```

CHECK constraints make impossible states unrepresentable: money stays
non-negative, the funding rate stays in 0–100, an `approved` application
always carries an `approved_amount_cents` (and only an approved one may),
and a `done` obligation always has a `done_at`.

### What is derived (never stored)

| Value | Rule |
| ----- | ---- |
| `funding_cap_cents` | `floor(eligible_costs × program.funding_rate / 100)` |
| `disbursed_cents` | `SUM(disbursements.amount_cents)` for the application |
| `remaining_cents` | `approved_amount − disbursed` (null while not approved) |
| `fully_disbursed` | approved and `disbursed === approved_amount` |
| obligation `state` | `done` / `overdue` / `at_risk` / `upcoming`, from the clock |
| portfolio totals | summed across applications and tranches at read time |

---

## Application status workflow

Config-driven, in exactly one file: **`server/status-config.ts`**.

```
draft        → submitted | withdrawn
submitted    → under_review | withdrawn
under_review → approved | rejected | withdrawn
approved     → (terminal)
rejected     → (terminal)
withdrawn    → (terminal)
```

- The forward path is `draft → submitted → under_review → approved`. We can
  **withdraw** any time before a decision.
- There is deliberately **no way back to `draft`** — once submitted the
  timeline only moves forward, so the append-only event stream reads as a
  true history.
- An **illegal transition** (e.g. `draft → approved`) returns **422**.
- Every move appends an `application_events` row (`from → to`, actor, note,
  and — on approval — the granted amount). **The timeline is never mutated.**
  The `applications.status` column is just the folded head of that stream,
  written in the same transaction as the event.

### Approval

Approving requires an **`approved_amount_cents`** that is **> 0** and **≤ the
program's `max_grant_cents`** — otherwise **422**, and nothing changes. The
approved amount may differ from what we requested; it is frozen on both the
application row and the timeline event.

### The requested-vs-cap sanity rule (enforced, not just warned)

On create/update, the requested amount is checked against the program's
funding cap:

```
requested_amount_cents ≤ floor(eligible_costs_cents × funding_rate / 100)
```

We **reject** an over-cap request with **422** (field
`requested_amount_cents`) rather than silently capping it. The cap is also
exposed as `funding_cap_cents` on every application so the UI can show it.
The rate is read from the program at validation time, so changing a
program's rate changes the cap for future edits.

---

## Disbursements (tranches) — derived balance

Approved applications receive money in one or more **tranches**
(`disbursed_on`, `amount_cents`, optional reference and note). The
disbursed total and the remaining balance are **derived from the
append-only `disbursements` rows** — never stored as a mutable counter:

```
remaining = approved_amount − SUM(tranches)
```

- Recording a tranche is only allowed on an **`approved`** application —
  otherwise **409**.
- A tranche that would take the total **over** the approved amount is
  rejected with **422 inside the transaction**, so nothing is written and
  the balance is unchanged.
- `fully_disbursed` flips true the moment `disbursed === approved_amount`.

---

## Reporting obligations & deadline derivation

Approved applications carry post-award **obligations** (interim report,
final report, proof of use, …), each a title, a `due_date`, and a `done`
flag with `done_at`. Obligations attach to **approved** applications only
(else 409).

Overdue / at-risk / upcoming is **derived at read time from an injectable
clock** (`server/reporting-config.ts`), never stored:

- A due date is treated as the **end of its calendar day** (23:59:59Z): an
  obligation due today is not overdue until today is over.
- **overdue** — not done and `now` is past the end of the due day.
- **at_risk** — not done, within `AT_RISK_DAYS` (default **30**) of the due
  day.
- **upcoming** — not done, comfortably before the due day.
- **done** — the flag is set (wins regardless of the date). Toggling records
  `done_at`.

The clock is injected: `createApp({ now })` drives both the timestamps
written on events and the "now" used for every deadline verdict, so tests
prove overdue/upcoming against fixed inputs without touching real time.

### Deadlines dashboard

`GET /api/dashboard` returns, all derived from the injected `now`:

- **program_deadlines** — application deadlines of programs that are still
  **open** (a closed program is excluded), each with its `overdue` /
  `at_risk` / `upcoming` state.
- **obligation_deadlines** — every **outstanding** (not-done) obligation
  across all applications, with the same verdict.
- **totals** — counts of overdue / at-risk / upcoming across both lists.
- **portfolio** — requested vs approved vs disbursed vs remaining, plus
  per-status counts, program and application counts.

---

## API reference

Session:

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/login` · `/api/logout` · `GET /api/me` | single admin login |

Everything below requires the `mod14_session` cookie — else **401**.

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET`  | `/api/config` | workflow + categories (session probe) |
| `GET`  | `/api/dashboard` | derived deadlines + portfolio |
| `GET`  | `/api/programs?status=&category=&search=` | list |
| `POST` | `/api/programs` | create |
| `GET`  | `/api/programs/:id` | detail + its applications |
| `PUT`  | `/api/programs/:id` | update (also used to close/reopen) |
| `DELETE` | `/api/programs/:id` | **409** if it has applications |
| `GET`  | `/api/applications?status=&program_id=&search=` | list |
| `POST` | `/api/applications` | create draft (requested ≤ cap → else 422) |
| `GET`  | `/api/applications/:id` | detail + timeline + tranches + obligations |
| `PUT`  | `/api/applications/:id` | edit (drafts only → else 409) |
| `DELETE` | `/api/applications/:id` | drafts only → else 409 |
| `POST` | `/api/applications/:id/transition` | `{ to, note?, approved_amount_cents? }` — illegal → 422 |
| `POST` | `/api/applications/:id/tranches` | `{ disbursed_on, amount_cents, reference?, note? }` |
| `POST` | `/api/applications/:id/obligations` | `{ title, due_date }` (approved only → 409) |
| `POST` | `/api/obligations/:id/toggle` | flip done / not-done |
| `GET`  | `/api/export/applications.csv` | one row per application, incl. approved/disbursed/remaining |

Errors are `{ error, details? }`. Validation failures are **422** with a
`details: [{ field, message }]` array.

---

## Configuration

All via environment variables (see `.env.example`); every value has a
local-dev default. The **status workflow** and the **at-risk window** are
*not* env vars — they are declarative code config
(`server/status-config.ts`, `server/reporting-config.ts`).

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3014` | API / production server port |
| `DATABASE_PATH` | `./data.db` | SQLite file (created automatically) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin` | the single login |
| `SESSION_SECRET` | `dev-secret-change-me` | signs the session cookie |
| `SESSION_TTL_HOURS` | `12` | session lifetime |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |

Change `ADMIN_PASSWORD` and `SESSION_SECRET` before deploying anywhere.

---

## Seed data

`npm run seed` (idempotent — skipped if any program exists) loads **6
funding programs** (mixed categories; some with deadlines, some rolling, one
closed) and **12 applications** across every status — including
approved-and-partially-disbursed, approved-and-fully-disbursed, rejected,
withdrawn and drafts — with tranche histories and reporting obligations
(some overdue, some at-risk, some upcoming). Everything is built **through
the domain functions**, so the seeded DB satisfies the same invariants as a
live one. Program deadlines and obligation due dates are **relative to seed
time**, so the derived overdue/at-risk/upcoming states are stable whenever
you seed. No binaries; everything is code.

---

## Deploy notes

`npm run build` compiles the client to `dist/client` and the server to
`dist/server`; `npm start` runs one Node process that serves the API and the
built SPA (client routes fall through to `index.html`). Point a persistent
volume at `DATABASE_PATH`. Put it behind TLS and set `COOKIE_SECURE=true`.

---

## Out of scope (deliberately)

- **Grantor / administrator features.** No third-party payouts, no applicant
  scoring, no funding-budget management — this is the applicant's side only.
- **Multi-user accounts & permissions.** One shared admin login (the
  MOD-03/04 pattern).
- **VAT / gross-net handling.** Eligible costs and grants are plain net
  amounts; there is no tax engine.
- **Business hours / calendars.** Deadline maths is plain calendar days —
  no working-day, weekend or holiday logic.
- **Multi-currency.** Amounts are EUR; the `currency` column is a fixed
  label, not an FX engine.
- **Document storage / attachments**, **e-signatures**, **notifications**
  (email/SMS/push), **direct integrations** with funding-body portals, and
  **analytics** beyond the deadlines dashboard and portfolio totals.
- **Rate limiting / CAPTCHA** — add at the edge.

---

MIT © 2026 0815software. See [LICENSE](./LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records key
state changes on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the
shared [`@0815software/platform-clients`](../../platform/clients) package
(it can also send via PS-03 when `NOTIFICATION_URL` is set). Best-effort and
opt-in — unset, the module runs standalone. See `server/platform.ts`.
