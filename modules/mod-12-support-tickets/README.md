# MOD-12 · Support Ticket System

Inbound support queue with assignment, a config-driven status workflow,
an append-only timeline, and **derived SLA timers** — around the clock or in
business hours, from a versioned policy a manager sets in the UI.
Attachments, canned responses and satisfaction ratings. Intake from a public
web form, an authenticated email-ingestion endpoint and — with PS-05 — the
support mailbox itself, over IMAP. Standalone it needs no external service,
no message broker and no cron.

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
  public replies, download their files, post a follow-up with files (which
  reopens a resolved ticket) and, once it is resolved, **rate** it.
- **Email intake** — the support mailbox, read through **PS-05** over IMAP
  ([below](#the-support-mailbox-ps-05)), and for any other bridge a
  shared-secret endpoint, `POST /api/intake/email`, that accepts an
  already-parsed email as JSON. Either opens a new ticket or adds a reply to
  the open one it refers to.
- **Agent console** (login) — the queue with filters and search, ticket
  detail with the full append-only thread (public replies vs internal
  notes, with their files), canned responses in the reply box,
  assign/reassign, status and priority changes, a **dashboard** (SLA and
  satisfaction), the agent roster, and — for a manager — the SLA policy,
  canned responses and settings.

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

**A ticket row stores only the immutable facts of intake**; everything else
is an event, or a row hung off one.

```
agents             id, name, email (unique), created_at
tickets            id, ref (unique), requester_name, requester_email,
                   subject, body, created_at
ticket_events      id, ticket_id, type, actor, actor_type,
                   visibility, payload (JSON), created_at
ticket_counters    year, last_seq          -- assigns TKT-<year>-<seq>
attachments        id, ticket_id, event_id, filename, content_type, size,
                   sha256, content (BLOB), created_at   -- append-only
csat_ratings       id, ticket_id, resolution_event_id (unique), score 1–5,
                   comment, created_at                   -- append-only
sla_policies       id, policy (JSON), created_by, created_at  -- versions
canned_responses   id, title (unique), body, active, created/updated by+at
helpdesk_settings  id = 1, settings (JSON), updated_by, updated_at
mail_ingests       id, dedupe_key (unique), message_id, connection_id, uid,
                   from_address, subject, action, reason, ticket_ref,
                   received_at                           -- append-only
```

`ticket_events.type` is one of `created`, `status_change`,
`priority_change`, `assignment`, `comment`. Rows are **append-only** —
never updated, never deleted. `visibility` (`public` | `internal`) is set
only on `comment` rows. `payload` carries the type-specific fields
(from/to status, priority change, assignee id/name, comment body, the
canned response a reply started from, the other sender of a mail kept
internal). Who may see an attachment is its event's visibility — never a
column of its own.

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
| `pending`           | the stretches spent in `pending` — what a policy with `pause_on_pending` cuts out |

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

Set in the UI by a manager (**SLA Policy**, `PUT /api/sla-policy`). Each
priority has two targets in **minutes**, counted **around the clock** or in
**business hours**:

| Priority | First response | Resolution | Default |
| -------- | -------------- | ---------- | ------- |
| `urgent` | 30 m           | 240 m (4 h)  | around the clock |
| `high`   | 60 m           | 480 m (8 h)  | around the clock |
| `normal` | 240 m (4 h)    | 1920 m (32 h) | around the clock |
| `low`    | 480 m (8 h)    | 3840 m (64 h) | around the clock |

The defaults (`server/sla-config.ts`) hold until someone saves a policy.
Business hours are the policy's weekly opening windows (up to three a day —
a lunch break is a gap), in its **IANA time zone**, minus its **holidays**.
**Waiting on the requester** can stop the resolution clock: with
`pause_on_pending`, the time a ticket spends in `pending` does not count
towards resolution. The first response is still owed — a ticket set to
pending before anyone answered it publicly does not get its first answer
for free.

**Versioned, never rewritten.** Every save is a new row in `sla_policies`
(append-only; an unchanged policy saves nothing). A ticket is held to the
version in force **when it came in**, so changing the targets today does not
turn last month's breaches into met ones; the ticket detail names its
version.

### How breach is derived (never stored)

For a ticket, given its `created_at`, its **current** priority, its
policy version, the two derived actuals, the stretches it waited on the
requester, and "now":

```
first_response_due = the instant first_response_minutes of clock have run since created_at
resolution_due     = the instant resolution_minutes of clock have run, minus the waits
```

"Clock" is real time around the clock, or only the opening windows in
business hours (`server/business-hours.ts`: local times turned into
instants with Intl and the zone, so the day the clocks change has its real
length). Each leg is evaluated fresh on every read (`evaluateSla` /
`evaluateLeg`):

- **met** — the actual (first agent reply / entered resolved) landed at or
  before its due time.
- **breached** — the actual landed *after* due, **or** there is no actual
  yet and now is past due.
- **paused** — the ticket waits on the requester and the policy stops the
  clock; `due_at` is when it would fall due if it ran again now.
- **at_risk** — no actual yet, before due, at most `at_risk_minutes` of
  clock left (default 60).
- **pending** — no actual yet, comfortably before due.

Each leg also reports `remaining_minutes` of clock and whether it counts
business hours. The clock is **injectable**: `createApp({ now })` drives
both the timestamps written on events and the "now" used for SLA, so tests
prove breach/met against fixed inputs without touching real time.

**Priority changes** are measured against the *new* priority's targets,
still counted from the original `created_at`. Escalating a slow ticket to
`urgent` can flip it straight to breached — by design.

### SLA dashboard

`GET /api/dashboard` derives, over all **non-closed** tickets: counts of
`breached` and `at_risk` tickets **by priority** (a ticket is breached if
either leg is breached), plus totals and per-status counts. Everything is
computed at read time from the events.

---

## Intake

### Web intake (public)

`POST /api/intake/web` with `{ requester_name, requester_email, subject,
body, priority, attachments? }` opens a ticket in status `new` and returns
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

### Email intake from any bridge

Besides the support mailbox (next section), one authenticated endpoint
accepts an *already-parsed* email from any other bridge:

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
- `attachments` (optional) — files, as on the web form.

Any bridge works as long as it POSTs the shape above with the shared
secret: a Postmark / SendGrid / Mailgun inbound webhook, an AWS SES →
Lambda that parses MIME, etc. Its parsing and retry policy are its own.

A tiny demo bridge is included:

```bash
# with the server running (INTAKE_SECRET must match)
node scripts/simulate-inbound.mjs                     # opens a new ticket
node scripts/simulate-inbound.mjs --ref TKT-2026-0021 # appends a reply
```

### The support mailbox (PS-05)

With `INTEGRATION_URL` and `PLATFORM_SERVICE_TOKEN` set, a manager picks a
PS-05 IMAP mailbox connection in **Settings** and switches it on. While the
server runs, it is read every `poll_seconds` (default 120; **CHECK NOW**
reads it at once). PS-05 holds the password, encrypted, and hands over the
unread mail parsed; `server/mailbox.ts` decides what each message becomes:

- **Once.** Every message is recorded by its Message-ID (`mail_ingests`).
  Only after that is the mailbox told to mark it read; should that fail, the
  next read sees the message again, recognises it, and makes no second
  ticket.
- **Threading.** A reference in the subject (`[TKT-2026-0007]` — the
  acknowledgement and every reply by email carry it) or the References
  header makes it a reply on that ticket, unless the ticket is closed;
  otherwise it opens a new ticket. A reply's quoted thread ("On … wrote:",
  "Am … schrieb …:", Outlook's header block) is cut off.
- **Only the requester speaks for the ticket.** A reference counts up and
  is guessable, so a reply whose From and Reply-To are both some other
  address is kept as an **internal note**, marked with its sender: it
  reaches neither the requester's page nor reopens the ticket. (This keeps
  a guessed reference out, not a forger — a mail's sender is what the mail
  says; SPF and DKIM are the mail server's job.)
- **No robot conversations.** Auto-replies, bounces and list mail (RFC
  3834, as PS-05 flags them) are recorded and ignored.
- **Nothing blocks the box.** A message that cannot be taken over is
  recorded as failed and marked read; it is still in the mailbox. Files over
  the limit, and signature images, are not taken over — the ticket says so.
- New tickets get the acknowledgement as from the web form; replies go to
  the sender's Reply-To when there is one.

The settings screen lists what each recent message became.

---

## Attachments

Files ride in the JSON of the request that carries them (`attachments:
[{ filename, content_type, content_base64 }]`) on the web form, a follow-up,
an agent's reply or note, and email intake. They are stored **in this
module's database** next to the event they came with, so the module needs
no file service and a backup of the database carries them; with
`FILES_URL`, PS-06 receives a copy of each (best-effort; the local row is
what is served). Limits: `ATTACHMENT_MAX_BYTES` per file (10 MiB),
`ATTACHMENTS_PER_MESSAGE` (5) — checked in the forms first and refused by
the server with **422** before anything is stored.

Who may download one follows its event: the opening request and public
replies are the requester's to see; a file on an internal note answers
**404** on the public route, exactly like a file that does not exist, and
so does another ticket's file through this ticket's link. Every download is
served as a **download** (`Content-Disposition: attachment`, `nosniff`, a
sandboxing CSP) — an uploaded HTML or SVG file never runs in this origin.

## Canned responses

The team's reply templates, kept by a manager (**Canned Responses**) and
offered in every reply box. Placeholders — `{{requester_name}}`,
`{{requester_first_name}}`, `{{ticket_ref}}`, `{{subject}}`,
`{{agent_name}}` — are filled by the server for the ticket, and the agent
edits the text before sending. An unknown placeholder is refused when the
template is saved. The reply records the template it started from; that is
the usage count. Switching one off hides it; deleting one loses nothing,
since every reply holds its full text.

## Satisfaction ratings

Switched on in **Settings**. Once a ticket is resolved, the requester rates
it on the status page — 1 to 5 stars and an optional comment — **once per
resolution**: the rating is keyed to the status change that resolved it, so
a ticket reopened and resolved again can be rated again, and a rating is
never overwritten. With PS-03 the requester can also be invited by email.
The dashboard derives the count, the average, the distribution and the
**CSAT percentage** (share of 4s and 5s), with the latest comments.

## Mail to the requester (PS-03)

With `NOTIFICATION_URL`, through `NOTIFICATION_ACK_CHANNEL`:

- the **acknowledgement** of a new ticket, with the status link;
- when switched on in **Settings**, every **public reply** —
  `Re: [TKT-…] <subject>`, the text, the names of attached files (they are
  on the status page) and the status link; internal notes never;
- when switched on, the **rating invitation** on resolution.

Each is keyed (`mod-12:reply:<event>`, `mod-12:csat:<event>`), so PS-03
sends it once. A failed send is logged and never fails the reply. Links use
`PUBLIC_BASE_URL`.

---

## API reference

Public (no auth):

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET`  | `/api/health` | liveness |
| `POST` | `/api/intake/web` | open a ticket, returns `{ ref, token }` |
| `POST` | `/api/intake/email` | shared-secret; open or append |
| `GET`  | `/api/public/tickets/:ref?token=` | requester status view (with files, and the rating state when ratings are on) |
| `POST` | `/api/public/tickets/:ref/comment?token=` | requester follow-up, with `attachments` |
| `GET`  | `/api/public/tickets/:ref/attachments/:id?token=` | a file on the request or a public reply; others 404 |
| `POST` | `/api/public/tickets/:ref/rating?token=` | `{ score, comment? }` once per resolution — 409 otherwise |
| `GET`  | `/api/public/config` | the file limits the forms check against |

Agent session:

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/login` · `/api/logout` · `GET /api/me` | single agent login |
| `GET`  | `/api/auth-mode` | local or SSO — which credentials the form names |

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
| `POST` | `/api/tickets/:ref/comment` | `{ body, visibility, attachments?, canned_id? }` |
| `GET`  | `/api/tickets/:ref/attachments/:id` | download a file of the ticket |
| `POST` | `/api/tickets/:ref/canned/:id/render` | a canned response filled for this ticket |
| `GET`  | `/api/canned-responses` | the templates, with how often each was used |
| `POST` · `PUT` · `DELETE` | `/api/canned-responses(/:id)` | `manage` |
| `GET` · `PUT` | `/api/sla-policy` | current version and history; saving is `manage` |
| `GET` · `PUT` | `/api/settings` | ratings, replies by email, mailbox; saving is `manage` |
| `GET` | `/api/mailbox` | `manage` — the PS-05 mailboxes, last read, what recent mail became |
| `POST` | `/api/mailbox/test` · `/api/mailbox/poll` | `manage` — log in / read it now (501 without PS-05) |

Errors are `{ error, details? }`. Validation failures are **422** with a
`details: [{ field, message }]` array.

---

## Configuration

All via environment variables (see `.env.example`); every value has a
local-dev default. The **workflow** is declarative code config
(`server/status-config.ts`); the **SLA policy**, ratings, replies by email
and the mailbox are set in the UI by a manager.

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3012` | API / production server port |
| `DATABASE_PATH` | `./data.db` | SQLite file (created automatically) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `agent` / `agent` | the single agent login |
| `SESSION_SECRET` | `dev-secret-change-me` | signs session cookies **and** public lookup tokens |
| `SESSION_TTL_HOURS` | `12` | agent session lifetime |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `INTAKE_SECRET` | `dev-intake-secret` | required in `X-Intake-Secret` on email intake |
| `PUBLIC_BASE_URL` | `http://localhost:3012` | where requesters reach this module — the links in mails |
| `ATTACHMENT_MAX_BYTES` | `10485760` | largest file (bytes) |
| `ATTACHMENTS_PER_MESSAGE` | `5` | files per message |
| `NOTIFICATION_URL` · `NOTIFICATION_ACK_CHANNEL` | — · `transactional-email` | PS-03 and the channel of every mail to a requester |
| `INTEGRATION_URL` + `PLATFORM_SERVICE_TOKEN` | — | PS-05: read the support mailbox |
| `FILES_URL` | — | PS-06: a copy of every attachment |

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
`COOKIE_SECURE=true`. Attachments live in the database, so the volume and
its backup carry them. To receive email, wire PS-05 and choose the mailbox
in Settings — or have another bridge POST to `/api/intake/email` with the
shared secret.

---

## Platform integration (optional)

mod-12 can consume the shared [Platform Services](../../platform) through the
[`@0815software/platform-clients`](../../platform/clients) package. When the
matching `*_URL` env vars are set:

- a **new ticket** is acknowledged to the requester via **PS-03 Notification
  Hub** and recorded on **PS-07 Audit Log**; PS-03 also carries replies and
  the rating invitation when the settings say so;
- the support mailbox is read through **PS-05 Integration Hub** (IMAP);
- every attachment is copied to **PS-06 File Storage**;
- `POST /api/tickets/:ref/suggest-reply` drafts an agent reply from the thread
  via **PS-04 AI Platform** (returns `501` when `AI_URL` is unset).

Every hook is best-effort — a downstream outage is logged and never fails
intake, a reply or a resolution. Everything is opt-in (`NOTIFICATION_URL`,
`AUDIT_URL`, `AI_URL`, `INTEGRATION_URL`, `FILES_URL`,
`PLATFORM_SERVICE_TOKEN`); unset, the module runs standalone. See
`server/platform.ts`.

## Out of scope (deliberately)

- **A mailbox without PS-05.** The IMAP client lives in PS-05, where the
  password is kept encrypted and other modules can use it too; standalone,
  mail comes in through `POST /api/intake/email`.
- **Different SLA per customer or per team.** One policy for the desk, in
  versions; no per-contract calendars.
- **Per-queue permissions.** Agents get their own logins and levels from
  PS-01 (see [Users and access levels](#users-and-access-levels)); the agent
  roster used for *assignment* is still seeded and read-only in the UI.
- **Customer accounts / passwords.** Requesters are identified by a signed
  per-ticket link, not a login.
- **Attachments on outgoing mail** (the mail names them; they are on the
  status page), **SMS/push**, **surveys beyond the one rating**, **macros
  that change state**, **merging & linking tickets**, **knowledge base**,
  and **analytics beyond the dashboard**.
- **Rate limiting / CAPTCHA** on the public form — add at the edge.

---

MIT © 2026 0815software. See [LICENSE](./LICENSE).

## Invariants and the tests that pin them

| Invariant | Test |
| --- | --- |
| Status, priority, assignee, first response, resolution are folded from the events, never stored | `test/api.test.ts` |
| SLA verdicts are derived at read time; business hours skip nights, weekends and holidays, and the day of the clock change has its real length | `test/business-hours.test.ts` |
| A ticket keeps the policy version it came in under; saving a policy never rewrites a verdict | `test/helpdesk.test.ts` |
| Waiting on the requester pauses the resolution clock only, and only when the policy says so | `test/business-hours.test.ts`, `test/helpdesk.test.ts` |
| A file on an internal note is never served to the requester; downloads are never rendered | `test/helpdesk.test.ts` |
| One rating per resolution, never overwritten | `test/helpdesk.test.ts` |
| A mail is taken over once, even when the mailbox was not told in time; mail from anyone but the requester stays internal and does not reopen | `test/mailbox.test.ts` |
| Standalone, nothing is sent and nothing fails | `test/helpdesk.test.ts`, `test/mailbox.test.ts` |

## Users and access levels

Standalone, this module has one login — the local admin — and it manages
everything. With PS-01 Identity wired (`IDENTITY_URL` + `IDENTITY_ORG`), every
person signs in as themselves and gets the level PS-01 grants them here:

| PS-01 permission | Level | May |
| --- | --- | --- |
| `module:support-tickets:view` | `view` | read everything, change nothing |
| `module:support-tickets:edit` | `edit` | the day-to-day work: create, update, delete |
| `module:support-tickets:manage` or `platform:admin` | `manage` | also what `server/access.ts` reserves |

`module:*:<level>` grants a level in every module. Reads need `view`, any other
method needs `edit`. Agents (`edit`) work tickets; how the desk runs — the SLA
policy, the settings, the canned responses, the mailbox — is `manage`. The
policy is one file, [`server/access.ts`](./server/access.ts). A refused request answers **403**
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
