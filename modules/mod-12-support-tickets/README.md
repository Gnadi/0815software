# MOD-12 · Support Ticket System

Inbound support queue with assignment, a config-driven status workflow,
an append-only timeline, and **derived SLA timers**. Two intake channels:
a public web form and an authenticated email-ingestion endpoint. Single
self-contained app — no external services, no message broker, no cron.

Part of the [0815software module catalogue](../README.md). MIT-licensed,
runs on its own, mirrors the stack and conventions of the other eleven
modules.

---

## What it is

One application with three faces:

- **Public web intake** (no login) — a submit-a-ticket form. Anyone can
  open a ticket; they get back a **reference** (`TKT-2026-0001`) and a
  private **HMAC-signed lookup token**. A status page at
  `/ticket/:ref?token=…` lets the requester watch progress, read the
  public replies, and post a follow-up (which reopens a resolved ticket).
- **Email intake** (shared-secret) — a single authenticated endpoint,
  `POST /api/intake/email`, that accepts an already-parsed email as JSON
  and either opens a new ticket or appends a reply to a matching open one.
  Wiring a real mailbox to it is the integration point and is **out of
  scope** (see below).
- **Agent console** (login) — the queue with filters and search, ticket
  detail with the full append-only thread (public replies vs internal
  notes), assign/reassign, status and priority changes, an **SLA
  dashboard**, the seeded agent roster, and the live SLA policy.

Everything about a ticket's *current* state — its status, priority,
assignee, first-response time, resolution time, and every SLA verdict —
is **derived from an append-only event stream at read time**. Nothing that
can drift is ever stored.

---

## Stack

- **Client**: Vite + React 19 + TypeScript (strict). Hand-rolled CSS in
  the 0815software token system — no UI framework.
- **Server**: Express 5 + better-sqlite3. Stateless HMAC cookie session
  for agents; stateless HMAC tokens for public ticket lookup.
- **Tests**: Vitest + Supertest.
- **Zero runtime services.** SQLite file, created on first run and seeded
  with example data. No new dependencies beyond the shared module stack.

Ports: **3012** (API / production server) · **5202** (Vite dev server).
Agent session cookie: `mod12_session`.

---

## Quickstart

```bash
npm install
npm run seed          # optional — the server also seeds an empty DB on first boot
npm run dev:api       # API on http://localhost:3012
npm run dev:web       # Vite UI on http://localhost:5202 (proxies /api → 3012)
```

Open <http://localhost:5202> for the **public submit form**. The **agent
console** is at <http://localhost:5202/agent> (default login `agent` /
`agent`). After submitting a ticket you are handed a private status link
(`/ticket/:ref?token=…`).

Production build (single process serves API + built client):

```bash
npm run build
npm start             # http://localhost:3012  (form at /, console at /agent)
```

```bash
npm test              # Vitest + Supertest
```

---

## Data model

Two content tables plus a per-year counter. **A ticket row stores only
the immutable facts of intake**; everything else is an event.

```
agents            id, name, email (unique), created_at
tickets           id, ref (unique), requester_name, requester_email,
                  subject, body, created_at
ticket_events     id, ticket_id, type, actor, actor_type,
                  visibility, payload (JSON), created_at
ticket_counters   year, last_seq          -- assigns TKT-<year>-<seq>
```

`ticket_events.type` is one of `created`, `status_change`,
`priority_change`, `assignment`, `comment`. Rows are **append-only** —
never updated, never deleted. `visibility` (`public` | `internal`) is set
only on `comment` rows. `payload` carries the type-specific fields
(from/to status, priority change, assignee id/name, comment body).

### Derived state (`server/tickets.ts`)

Folding the event stream, oldest first, yields:

| Field               | Rule |
| ------------------- | ---- |
| `status`            | starts at `new`, walked by `status_change` events |
| `priority`          | the `created` event's hint, walked by `priority_change` |
| `assignee_id`       | the latest `assignment` event |
| `first_response_at` | the earliest **public** comment authored by an **agent** |
| `resolved_at`       | the first time the ticket entered `resolved` |
| `updated_at`        | the timestamp of the most recent event |

Because none of these are columns, they cannot drift. The same discipline
as MOD-06's derived PO status, applied to a help desk.

---

## Status workflow

Config-driven, in exactly one file: **`server/status-config.ts`**.

```
new  →  open | pending | resolved
open →  pending | resolved
pending → open | resolved
resolved → open | closed
closed → open            (reopen)
```

An illegal transition returns **422**. Transitioning to the current
status is also a 422 (no-op). The agent console only offers legal targets
(from `allowed_transitions` in the ticket detail), and the SLA-policy page
renders this table straight from the config.

**Reopen.** A requester follow-up (from the public status page, or an
email reply routed to email intake) on a `resolved` or `closed` ticket
appends the comment **and** a `status_change` back to `open`, tagged
`reopened: true` in the payload. The reopen is itself an event — the
timeline records it.

---

## SLA policy & configuration

Config-driven, in exactly one file: **`server/sla-config.ts`**. Each
priority has two targets, in **minutes from creation**:

| Priority | First response | Resolution |
| -------- | -------------- | ---------- |
| `urgent` | 30 m           | 240 m (4 h)  |
| `high`   | 60 m           | 480 m (8 h)  |
| `normal` | 240 m (4 h)    | 1920 m (32 h) |
| `low`    | 480 m (8 h)    | 3840 m (64 h) |

To change the policy, edit that file — nothing else in the codebase knows
the numbers. The agent console renders the table from `GET /api/config`.

### How breach is derived (never stored)

For a ticket, given its `created_at`, its **current** priority, the two
derived actuals, and "now":

```
first_response_due = created_at + priority.first_response_minutes
resolution_due     = created_at + priority.resolution_minutes
```

Each leg is evaluated fresh on every read (`evaluateSla` /
`evaluateLeg`):

- **met** — the actual (first agent reply / entered resolved) landed at or
  before its due time.
- **breached** — the actual landed *after* due, **or** there is no actual
  yet and now is past due.
- **at_risk** — no actual yet, before due, but within `AT_RISK_MINUTES`
  (default 60) of due.
- **pending** — no actual yet, comfortably before due.

The clock is **injectable**: `createApp({ now })` drives both the
timestamps written on events and the "now" used for SLA, so tests prove
breach/met against fixed inputs without touching real time.

**Priority changes** are measured against the *new* priority's targets,
still counted from the original `created_at`. Escalating a slow ticket to
`urgent` can flip it straight to breached — by design.

### Explicitly out of scope for SLA

- **Business hours / calendars.** Targets are **wall-clock** elapsed time.
  There is no 9-to-5 window, no weekend pause, no holiday calendar.
- **Pause-on-pending.** The resolution clock does **not** stop while a
  ticket waits on the requester in `pending`. If you need "stop-the-clock"
  semantics, that is a policy extension, not shipped here.

### SLA dashboard

`GET /api/dashboard` derives, over all **non-closed** tickets: counts of
`breached` and `at_risk` tickets **by priority** (a ticket is breached if
either leg is breached), plus totals and per-status counts. Everything is
computed at read time from the events.

---

## Intake

### Web intake (public)

`POST /api/intake/web` with `{ requester_name, requester_email, subject,
body, priority }` opens a ticket in status `new` and returns
`{ ref, token, status }`. The `token` is `HMAC(secret, "ticket:" + ref)` —
a ticket ref is guessable, the token is not, and it gates the status page.

The requester-facing routes are public but token-gated:

- `GET  /api/public/tickets/:ref?token=…` — status + public timeline
  (created event, public replies, status changes). **Internal notes,
  assignments and priority changes never appear here.**
- `POST /api/public/tickets/:ref/comment?token=…` — add a follow-up
  (reopens a resolved/closed ticket).

A wrong or missing token is a **404**, indistinguishable from "no such
ticket".

### Email intake (integration point — real mailbox out of scope)

MOD-12 does **not** talk to a mailbox. It exposes one authenticated
endpoint that accepts an *already-parsed* email:

```
POST /api/intake/email
Header:  X-Intake-Secret: <shared secret>
Body:    { "from": "...", "subject": "...", "body": "...",
           "in_reply_to": "TKT-2026-0001" }   // in_reply_to optional
```

- Missing secret header → **401**. Wrong secret → **403**.
- `in_reply_to` matches a ticket that is **not closed** → the body is
  appended as a **public** comment (reopening it if resolved), returns
  `{ ref, action: "appended" }`.
- Otherwise (no match, unknown ref, or a closed ticket) → a **new** ticket
  is opened at `normal` priority, returns `{ ref, action: "created" }`.

**Wiring a real inbox is the integration point and is out of scope.** Any
bridge works as long as it POSTs the shape above with the shared secret:
an IMAP poller, a Postmark / SendGrid / Mailgun inbound webhook, an AWS
SES → Lambda that parses MIME, etc. The parsing, threading heuristics,
spam filtering and retry policy of that bridge are yours to own.

A tiny demo bridge is included:

```bash
# with the server running (INTAKE_SECRET must match)
node scripts/simulate-inbound.mjs                     # opens a new ticket
node scripts/simulate-inbound.mjs --ref TKT-2026-0021 # appends a reply
```

---

## API reference

Public (no auth):

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET`  | `/api/health` | liveness |
| `POST` | `/api/intake/web` | open a ticket, returns `{ ref, token }` |
| `POST` | `/api/intake/email` | shared-secret; open or append |
| `GET`  | `/api/public/tickets/:ref?token=` | requester status view |
| `POST` | `/api/public/tickets/:ref/comment?token=` | requester follow-up |

Agent session:

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/login` · `/api/logout` · `GET /api/me` | single agent login |

Agent (require `mod12_session` cookie — else **401**):

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET`  | `/api/config` | workflow + SLA policy (session probe) |
| `GET`  | `/api/agents` | seeded roster |
| `GET`  | `/api/dashboard` | derived SLA counts |
| `GET`  | `/api/tickets?status=&priority=&assignee=&search=` | queue |
| `GET`  | `/api/tickets/:ref` | detail + full timeline + `allowed_transitions` |
| `POST` | `/api/tickets/:ref/status` | `{ to }` — illegal → 422 |
| `POST` | `/api/tickets/:ref/priority` | `{ priority }` |
| `POST` | `/api/tickets/:ref/assign` | `{ assignee_id }` (null unassigns) |
| `POST` | `/api/tickets/:ref/comment` | `{ body, visibility }` |

Errors are `{ error, details? }`. Validation failures are **422** with a
`details: [{ field, message }]` array.

---

## Configuration

All via environment variables (see `.env.example`); every value has a
local-dev default. The **workflow** and the **SLA policy** are *not* env
vars — they are declarative code config (`server/status-config.ts`,
`server/sla-config.ts`).

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3012` | API / production server port |
| `DATABASE_PATH` | `./data.db` | SQLite file (created automatically) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `agent` / `agent` | the single agent login |
| `SESSION_SECRET` | `dev-secret-change-me` | signs session cookies **and** public lookup tokens |
| `SESSION_TTL_HOURS` | `12` | agent session lifetime |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `INTAKE_SECRET` | `dev-intake-secret` | required in `X-Intake-Secret` on email intake |

Change `ADMIN_PASSWORD`, `SESSION_SECRET` and `INTAKE_SECRET` before
deploying anywhere.

---

## Seed data

`npm run seed` (idempotent — skipped if any agent exists) loads **5
agents** and **15 tickets** across every status and every priority, built
entirely through the domain functions so the seeded DB satisfies the same
invariants as a live one. Timestamps are **relative to seed time**, so the
derived SLA states are stable whenever you seed: some tickets are
first-response breached, one resolution is breaching in progress, one is
in the at-risk window, several are comfortably within SLA, one has been
reopened by a requester follow-up, and both web- and email-channel intake
are represented. No binaries; everything is code.

---

## Deploy notes

`npm run build` compiles the client to `dist/client` and the server to
`dist/server`; `npm start` runs one Node process that serves the API and
the built SPA (client routes fall through to `index.html`). Point a
persistent volume at `DATABASE_PATH`. Put it behind TLS and set
`COOKIE_SECURE=true`. To receive email, stand up your mailbox bridge and
have it POST to `/api/intake/email` with the shared secret — the only
moving part you add.

---

## Platform integration (optional)

mod-12 can consume the shared [Platform Services](../../platform) through the
[`@0815software/platform-clients`](../../platform/clients) package. When the
matching `*_URL` env vars are set:

- a **new ticket** is acknowledged to the requester via **PS-03 Notification
  Hub** and recorded on **PS-07 Audit Log**;
- `POST /api/tickets/:ref/suggest-reply` drafts an agent reply from the thread
  via **PS-04 AI Platform** (returns `501` when `AI_URL` is unset).

Ticket-creation hooks are best-effort — a downstream outage is logged and
never fails intake. Everything is opt-in (`NOTIFICATION_URL`, `AUDIT_URL`,
`AI_URL`, `PLATFORM_SERVICE_TOKEN`); unset, the module runs standalone. See
`server/platform.ts`.

## Out of scope (deliberately)

- **A real mailbox / IMAP / inbound webhook.** Only the parsed-JSON
  ingestion endpoint ships; the mail bridge is the integration point.
- **Business hours, calendars, and pause-on-pending SLA.** Wall-clock
  targets only.
- **Multi-agent accounts & permissions.** One shared agent login (the
  MOD-03/04 pattern); the agent roster used for *assignment* is seeded and
  read-only in the UI.
- **Customer accounts / passwords.** Requesters are identified by a signed
  per-ticket link, not a login.
- **Notifications** (email/SMS/push), **CSAT surveys**, **canned
  responses / macros**, **attachments & file storage**, **merging &
  linking tickets**, **knowledge base**, and **analytics beyond the SLA
  dashboard**.
- **Rate limiting / CAPTCHA** on the public form — add at the edge.

---

MIT © 2026 0815software. See [LICENSE](./LICENSE).

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
