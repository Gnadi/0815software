# MOD-10 · CRM Lite

Contacts, companies, deals, an append-only activity log and a
config-driven pipeline. No AI upsells, no seat caps, no surprises. Part
of the [0815software](https://0815software.com) module catalogue —
standard business software, MIT-licensed, always free.

**No AI. No seat caps. No telemetry. No external calls.** The whole app
is one Node process and one SQLite file. It never phones home, never
counts your users, and has no "contact sales" button.

Three correctness properties are the point of this module, and the test
suite proves each of them:

1. **Every stage change is an append-only event.** Moving a deal writes a
   row into `deal_stage_events` (from, to, kind, note, timestamp) that is
   never updated or deleted. The deal's `stage` column is a convenience
   cache for querying, and the domain layer guarantees it **always**
   equals the latest event's `to_stage` — a test asserts that invariant
   across a whole move sequence.
2. **Won and lost are terminal.** Once a deal is `won` or `lost` it
   cannot move again (→ 409). The only way out is an explicit **reopen**,
   a distinct action that appends a recorded `reopen` event back to an
   active stage.
3. **Everything derived is derived, never stored.** A deal's expected
   value (value × the current stage's win-probability) and every pipeline
   metric (per-stage counts and sums, win rate) are recomputed on read
   from the deals plus the one pipeline config file. Nothing derived ever
   hits a column, so nothing can drift.

## Stack

Deliberately standard and boring (identical to MOD-01 … MOD-09):

| Layer    | Choice                                      |
| -------- | ------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)       |
| API      | Node + Express 5                            |
| Storage  | better-sqlite3 (single file, zero services) |
| Styling  | Hand-rolled CSS, no framework               |
| Tests    | Vitest + Supertest                          |

Runtime dependencies: `express`, `better-sqlite3`, `react`,
`react-dom`. That's all — no CDN, no external services, no analytics.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-10-crm-lite
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3010
npm run dev:api

# terminal 2 — UI on :5200 (proxies /api to :3010)
npm run dev:web
```

Open http://localhost:5200 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3010
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. No binary database file is committed; delete
`data.db` at any time to start fresh.

## Data model

| Table               | What it holds                                                                 |
| ------------------- | ----------------------------------------------------------------------------- |
| `companies`         | Accounts: name, domain, notes.                                                |
| `contacts`          | People: name, email, phone, title, optional `company_id`.                     |
| `deals`             | Opportunities: title, `company_id`, optional `primary_contact_id`, value in integer cents, current `stage` (cache), note. |
| `deal_stage_events` | **Append-only.** One row per stage transition: `from_stage`, `to_stage`, `kind` (`open`/`move`/`reopen`), note, timestamp. |
| `activities`        | **Append-only** log: type (`call`/`email`/`meeting`/`note`), subject, body, optional `contact_id` and/or `deal_id`, optional follow-up `due_date`, `done`/`done_at`. |

Money is always integer cents (MOD-04's discipline); euros exist only at
the rendering edge (`shared/money.ts`). Deleting a **contact** clears it
from deals and activities (`ON DELETE SET NULL`) so history survives.

## Pipeline & stages — one config file

The pipeline lives in exactly one place:
[`server/pipeline-config.ts`](server/pipeline-config.ts). It is an
ordered list of stages, each with a `key`, a `label` and a default
win-`probability` (integer percent). The UI renders its kanban columns,
stage dropdowns and probabilities from this list (served to the client
via `GET /api/config`) — nothing hardcodes a stage anywhere else.

```ts
export const STAGES: Stage[] = [
  { key: 'lead',        label: 'Lead',        probability: 10,  terminal: false },
  { key: 'qualified',   label: 'Qualified',   probability: 30,  terminal: false },
  { key: 'proposal',    label: 'Proposal',    probability: 55,  terminal: false },
  { key: 'negotiation', label: 'Negotiation', probability: 80,  terminal: false },
  { key: 'won',         label: 'Won',         probability: 100, terminal: true  },
  { key: 'lost',        label: 'Lost',        probability: 0,   terminal: true  },
];
```

Rules enforced by a self-check that runs at import (misconfiguration
fails loudly at startup, never silently at runtime):

- stage keys are unique and lowercase; probabilities are integers 0–100;
- the **last two** stages are the terminal outcomes, in this exact order:
  `won` (probability 100) then `lost` (probability 0);
- only those two stages may be `terminal`.

Edit this file to reshape the pipeline — add a "discovery" stage, rename
"proposal", change a probability. Existing deals keep working; their
history is untouched.

## Deals — the lifecycle rules

- **Create** → the deal starts at the first stage (or a chosen active
  stage) and an `open` stage event is written in the same transaction, so
  the invariant holds from the very first moment.
- **Move** (`POST /api/deals/:id/stage`) → appends a `move` event and
  updates the cached `stage` in one transaction.
  - Unknown target stage → **422**.
  - Move to the **same** stage → **409** (documented no-op; no event is
    written).
  - Move a **terminal** (won/lost) deal → **409**.
- **Reopen** (`POST /api/deals/:id/reopen`) → the only way out of a
  terminal stage. Appends a `reopen` event (recorded forever) and moves
  the deal to an active stage.
  - Reopen a non-terminal deal → **409**; reopen **into** a terminal
    stage → **422**.
- **Expected value** = `round(value_cents × stage.probability / 100)` —
  derived on every read, never stored.

## Pipeline metrics

`GET /api/metrics[?from=YYYY-MM-DD&to=YYYY-MM-DD]` computes, entirely on
read:

- **per stage** — count of deals, sum of value, sum of expected value;
- **totals** across all stages;
- **win rate** — `won / (won + lost)`, restricted to deals that *closed*
  inside the date range (the date of the latest stage event that put them
  into `won`/`lost`). `rate` is `null` when nothing closed in range.

The dashboard renders these as a funnel and a set of stat tiles.

## Activity log & follow-ups

Activities are an append-only timeline linked to a contact and/or a deal
(at least one). They render newest-first on contact and deal detail
pages. An activity with a `due_date` is a **follow-up**;
`GET /api/followups` derives the open list (not done), flagging each as
`overdue` when its due date is in the past.

The **only** mutation the append-only log permits is toggling a
follow-up's `done` flag (`POST /api/activities/:id/done`), and even that
is recorded in `done_at`. Toggling an activity that has no due date →
**409**.

## API

All routes are under `/api`. Everything except `/api/health` and
`/api/login` requires a valid session cookie (`mod10_session`); without
one the API returns **401**.

| Method + path                     | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `POST /api/login`                 | Log in; sets the `mod10_session` cookie.            |
| `POST /api/logout`                | Clear the session.                                  |
| `GET /api/me`                     | Current admin username.                             |
| `GET /api/config`                 | Pipeline stages + activity types (the UI's source). |
| `GET/POST /api/companies`         | List / create companies.                            |
| `GET/PUT/DELETE /api/companies/:id` | Detail (with contacts + deals) / update / delete. Delete → **409** if it has contacts or deals. |
| `GET/POST /api/contacts`          | List (filter `?search=`, `?company_id=`) / create.  |
| `GET/PUT/DELETE /api/contacts/:id`  | Detail (with deals + activity timeline) / update / delete. |
| `GET/POST /api/deals`             | List (filter `?stage=`, `?search=`) / create.       |
| `GET/PUT/DELETE /api/deals/:id`   | Detail (stage history + activities) / update / delete. |
| `POST /api/deals/:id/stage`       | Move to `{ stage, note? }`.                         |
| `POST /api/deals/:id/reopen`      | Reopen a terminal deal to `{ stage?, note? }`.      |
| `GET/POST /api/activities`        | Full log / append an activity.                      |
| `POST /api/activities/:id/done`   | Toggle a follow-up `{ done }`.                       |
| `GET /api/followups`              | Open (or `?include_done=true`) follow-ups, overdue flagged. |
| `GET /api/metrics`                | Derived pipeline metrics (`?from=&to=` for win rate). |
| `GET /api/deals.csv`              | CSV export of every deal.                           |

Validation errors are **422** with a `details: [{ field, message }]`
array; missing rows are **404**; lifecycle violations are **409**.

## Configuration

Copy `.env.example` to `.env` (every value has a local-dev default):

| Variable           | Default               | Meaning                                   |
| ------------------ | --------------------- | ----------------------------------------- |
| `PORT`             | `3010`                | API / production server port.             |
| `DATABASE_PATH`    | `./data.db`           | SQLite file (created automatically).      |
| `ADMIN_USERNAME`   | `admin`               | The single staff login.                   |
| `ADMIN_PASSWORD`   | `admin`               | **Change in production.**                 |
| `SESSION_SECRET`   | `dev-secret-change-me`| HMAC secret for the session cookie.       |
| `SESSION_TTL_HOURS`| `12`                  | Session lifetime.                         |
| `COOKIE_SECURE`    | `false`               | Set `true` behind HTTPS.                  |

Auth is a single admin, exactly as in MOD-03/04/06: credentials from env
vars, a stateless HMAC-signed session token in an `HttpOnly` cookie. No
user table, no seats to count.

## Scripts

| Script            | Does                                                       |
| ----------------- | ---------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch) on `:3010`.                    |
| `npm run dev:web` | Vite dev server on `:5200`, proxying `/api`.               |
| `npm run seed`    | Load the example dataset into `DATABASE_PATH` (idempotent).|
| `npm run build`   | Type-check, compile the server, build the client.          |
| `npm start`       | Run the compiled server (API + built client) on `:3010`.   |
| `npm test`        | Vitest + Supertest suite.                                  |

## Deploy notes

Build, then run one Node process:

```sh
npm run build
ADMIN_PASSWORD=… SESSION_SECRET=$(openssl rand -hex 32) COOKIE_SECURE=true npm start
```

`npm start` serves the built client from `dist/client` and the API from
the same origin, so there is no CORS to configure. Put it behind a
TLS-terminating reverse proxy and set `COOKIE_SECURE=true`. The database
is a single file — back it up by copying it (WAL mode; a plain copy while
stopped is safest).

## Out of scope

CRM Lite is deliberately small. It does **not** include, and will not
grow:

- AI/LLM anything — no lead scoring, no "smart" suggestions, no chat;
- multi-user accounts, roles, permissions or per-seat billing (it is a
  single admin login);
- email/calendar sync, IMAP/SMTP, or any outbound integration;
- telemetry, analytics, tracking pixels or crash reporting;
- automation/workflows, web forms, marketing campaigns;
- custom fields, multiple pipelines per workspace, or currency
  conversion (one pipeline, euros as integer cents);
- import wizards or deduplication.

If you need one of those, fork it — the code is yours under MIT.

## License

MIT © 0815software. See [LICENSE](LICENSE).

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records key
state changes on [PS-07 Audit Log](../../platform/ps-07-audit-log) via the
shared [`@0815software/platform-clients`](../../platform/clients) package.
Calls are best-effort and opt-in — unset, the module runs standalone. See
`server/platform.ts`.
