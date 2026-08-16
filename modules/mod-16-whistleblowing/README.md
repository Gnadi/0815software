# MOD-16 · Whistleblowing

> **What this module is for.** Since December 2023, every employer in Germany
> and Austria with 50 or more workers must run an **internal reporting
> channel** — Hinweisgeberschutzgesetz (HinSchG), transposing Directive (EU)
> 2019/1937. The obligation is not "have an inbox": it is to confirm receipt
> within **seven days**, give the reporter substantive feedback within **three
> months**, keep their identity confidential, and delete the documentation
> **three years** after the procedure ends. This module is those four
> obligations, made mechanical.

An anonymous internal reporting channel with a two-way follow-up path, a
derived deadline clock, an append-only case trail and a retention clock that
ends in an actual erasure. Single self-contained app — no external services,
no cron, no message broker.

Part of the [0815software module catalogue](../README.md). MIT-licensed,
runs on its own, mirrors the stack and conventions of the other modules.

---

## What it is

Three faces, two of them public:

- **`/` — file a report.** No account, no name, no email. Pick a category,
  write what happened, get an access code.
- **`/status` — check a report.** The access code opens the case: its status,
  the dates the organisation owes you something by, the replies you have been
  sent, and a box to add more.
- **`/handler` — the case console.** The queue with both clocks on every row,
  the case detail with the reporter channel and the internal notes kept
  visibly apart, the lifecycle actions, and the erasure.

---

## Stack

- **Client**: Vite + React 19 + TypeScript (strict). Hand-rolled CSS in the
  0815software token system — no UI framework.
- **Server**: Express 5 + better-sqlite3. Stateless HMAC cookie session for
  the handler; the reporter has no session at all.
- **Tests**: Vitest + Supertest.
- **Zero runtime services.** SQLite file, created and seeded on first run.
  No new dependencies beyond the shared module stack.

Ports: **3016** (API / production server) · **5206** (Vite dev server).
Session cookie: `mod16_session`.

---

## Quickstart

```bash
npm install
npm run dev:api     # http://localhost:3016 — API + seeded SQLite
npm run dev:web     # http://localhost:5206 — Vite dev server, proxies /api
```

The handler console is at `/handler`; sign in with `admin` / `admin`
(local-dev default — change both before deploying). `npm test` runs the
suite; `npm run build && npm start` serves the built client and the API from
one Node process.

---

## The access code

The only credential that matters here, and the one thing the module
deliberately **cannot recover**.

A whistleblower has no account, no email and no name. The code is how they
come back to read the answer they are owed and to add to their report, and it
is the only link between the person and the case. That shapes three
decisions, all in `server/codes.ts`:

1. **It is random, not derived.** MOD-12 signs its ticket ref with the server
   secret, which is right for a help desk — anyone who legitimately knows a
   ref may see the ticket. Here the ref must *not* be enough. A code derived
   from the ref would mean anyone who can list case refs, or who ever sees
   the secret, can read every reporter's channel and post as them.
2. **Only its SHA-256 is stored.** A database copy, a backup on a laptop or a
   subpoena of the file yields hashes. Nobody in the organisation, including
   whoever runs it, can open a reporter's channel.
3. **A lost code cannot be reset.** Building a reset flow would require
   knowing who the reporter is — precisely what this module refuses to know.
   The UI says so, in the one screen where the code is readable, behind a
   confirmation.

20 symbols of Crockford base32 (no I, L, O or U — a reporter may be copying
this onto paper under stress) = **100 bits of entropy**. Typed back in any
case, with or without dashes or spaces, it still resolves.

SHA-256 rather than a KDF, deliberately: the code comes from a CSPRNG, so
there is no dictionary to run and no cost factor that would add anything.
Compare `server/auth.ts`, where the *human-chosen* admin password is hashed
with scrypt.

The code travels in a **POST body, never in a URL** — query strings survive
in request logs, browser history, `Referer` headers and every proxy in
between. `POST /api/public/case` is rate-limited per IP on its own bucket
(`server/throttle.ts`), the same treatment `/api/login` gets.

---

## The deadlines (`server/deadlines.ts`)

Derived on every read from the case's own facts and an injected clock. A
stored due date is wrong the moment somebody corrects a receipt timestamp,
and a stored breach flag stays false because the nightly job that was
supposed to set it did not run.

| Obligation | Rule | Runs from |
| ---------- | ---- | --------- |
| Confirm receipt | § 17 Abs. 1 HinSchG · **7 days** | receipt |
| Give feedback | § 17 Abs. 2 HinSchG · **3 months** | the acknowledgement — **or the expiry of the seven days, when none was ever sent** |
| Erase documentation | § 11 Abs. 5 HinSchG · **3 years** | conclusion of the procedure |

That fallback in the second row is Art. 9(1)(f) of the directive and it is
the point of the whole clock: **failing to acknowledge does not postpone the
feedback obligation, it starts it.** A case sitting untouched accrues *both*
failures rather than none.

Three months means three **calendar** months, not 90 days, and a day that
does not exist in the target month clamps to the end of it (§ 188 Abs. 3
BGB) — 30 November plus three months is 28 February. All arithmetic is UTC,
so no deployment's timezone can move a legal deadline by an hour.

**What counts as feedback**: a message the reporter can actually read, or the
conclusion of the case. Deliberately *not* the acknowledgement (that is
receipt), *not* an internal note however thorough, and *not* the reporter's
own follow-up. Counting any of those would let a case satisfy the
three-month obligation without a word reaching the person who filed it.

**A late answer stays `missed`, not `met`.** "We replied, three weeks late"
is exactly what an audit asks about, and a view that flipped to `met` when
the reply landed would hide every late response the module ever recorded.

---

## Confidentiality

- **The reporter channel and the internal notes share one table and are
  separated by one column.** `visibility` is `reporter` or `internal`, it is
  hard-coded on the public routes, and there is no default — a message
  without it is a 422 rather than a guess. Whichever default were chosen,
  half the callers that forget the field would get the wrong one, and one of
  those halves publishes an internal note.
- **The reporter's view is a different document, built from scratch**
  (`ReporterView` in `shared/types.ts`), not the handler's view with fields
  deleted. Building the second by subtraction is how internal notes end up
  in a public response.
- **Audit records carry the ref and the verb, never the content.** PS-07 is a
  different service with a different audience. `WB-2026-0007 was acknowledged
  by anna` is an audit trail; the allegation is not part of one.
- **Nothing in the schema can hold an identity the reporter did not
  volunteer.** No IP column, no user agent, no session, no `created_by` —
  not "we do not display it", there is nowhere to put it. A test asserts the
  exact column list of `cases` and fails if one ever appears.

---

## Data model

Three tables (`server/db.ts`):

- **`cases`** — the immutable facts of intake: ref, category, subject, body,
  whatever contact the reporter chose to give, the hash of the access code,
  and when it arrived. **No status column, no outcome column, no deadline
  columns.**
- **`case_events`** — append-only. Every acknowledgement, status change,
  message and erasure. Never updated, never deleted.
- **`case_counters`** — the per-year sequence behind `WB-2026-0001`.

### What is derived (never stored)

The current status, the outcome, the acknowledgement instant, the conclusion
instant, both statutory deadlines and their states, the retention date, and
whether the case is anonymous. All folded from the event stream at read time
in `server/cases.ts`.

---

## Case lifecycle

```
received ──▶ acknowledged ──▶ investigating ──▶ closed
                  └──────────────────────────────▲
```

`closed` is terminal and requires an **outcome** — substantiated, partly
substantiated, unsubstantiated, out of scope, referred, or insufficient
information. "Closed" with no reason is the state a report ends up in when
nobody wants to write down what was decided, and it is exactly what an audit
asks about.

**A case that was never acknowledged cannot be closed** (409). The
acknowledgement is the § 17 Abs. 1 act and it is what starts the feedback
clock; a closed case nobody can reopen would bury the fact that it never
happened. The module refuses rather than warns.

---

## Erasure — § 11 Abs. 5 HinSchG

Three years after the procedure is concluded, the documentation is deleted.
`POST /api/cases/:id/erase` does exactly that:

- The report body, the subject, the contact details and **every message
  body** are set to NULL — in the database, not just in the response.
- The case skeleton and the full event trail survive: ref, category, dates,
  statuses, outcome, who acted when. The organisation still has to be able to
  show it ran a compliant procedure, and an erasure that left no trace of
  itself would be indistinguishable from a case quietly disappearing.
- It is refused while the case is still open, and refused before the
  retention date unless `force` is passed. Erasing early destroys evidence
  somebody may still be entitled to, so it takes a deliberate act.
- It is irreversible. Afterwards the case accepts no messages and no further
  erasure; the reporter's code still resolves — the case existed — but there
  is nothing left to read.

---

## API reference

Public — no session, by design:

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET`  | `/api/health` · `/api/ready` | probes |
| `GET`  | `/api/public/config` | organisation, categories, the statutory windows |
| `POST` | `/api/public/reports` | `{ category, subject, body, contact? }` → **201** `{ ref, code, acknowledge_due_at }` |
| `POST` | `/api/public/case` | `{ code }` → the reporter's view. Throttled. |
| `POST` | `/api/public/case/messages` | `{ code, body }` → follow-up. Throttled. |

Everything below requires the `mod16_session` cookie — else **401**.

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/login` · `/api/logout` | the case handler |
| `GET`  | `/api/config` | categories, outcomes, statuses, the server's now |
| `GET`  | `/api/overview` | derived counts of outstanding obligations |
| `GET`  | `/api/cases?status=&category=&attention=` | queue |
| `GET`  | `/api/cases/:id` | detail + both channels + the trail |
| `POST` | `/api/cases/:id/acknowledge` | the § 17 Abs. 1 act |
| `POST` | `/api/cases/:id/investigate` | |
| `POST` | `/api/cases/:id/close` | `{ outcome }` — required |
| `POST` | `/api/cases/:id/messages` | `{ visibility, body }` — visibility required |
| `POST` | `/api/cases/:id/erase` | `{ force? }` |

The lifecycle steps are **verb routes rather than a PATCH of `status`**.
`acknowledge` is not a synonym for "set status": it is the statutory act, it
starts the three-month clock, and naming it that way is the difference
between an API that reads like the law and one that reads like a table.

Errors are `{ error, details? }`. Validation failures are **422** with a
`details: [{ field, message }]` array.

---

## Configuration

All via environment variables (see `.env.example`); every value has a
local-dev default. The categories, the lifecycle and the three statutory
periods are *not* env vars — they are declarative code config
(`server/case-config.ts`).

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3016` | API / production server port |
| `DATABASE_PATH` | `./data.db` | SQLite file (created automatically) |
| `ORGANISATION_NAME` | `Example GmbH` | who the public page names as recipient |
| `LOOKUP_RATE_LIMIT_RPM` | `20` | per-IP access-code lookups per minute |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin` | the handler login |
| `SESSION_SECRET` | `dev-secret-change-me` | signs the session cookie |
| `SESSION_TTL_HOURS` | `12` | session lifetime |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |

Numeric settings are **validated, not coerced**: `PORT=808O` (a letter O) or
`LOOKUP_RATE_LIMIT_RPM=-1` refuses to boot rather than silently falling back
to a default. A blank value still means "unset" — that is what an
uninterpolated compose variable yields.

Change `ADMIN_PASSWORD` and `SESSION_SECRET` before deploying anywhere;
`server/guard.ts` refuses to start in production with the defaults.

---

## Seed data

`npm run seed` (idempotent — skipped if any case exists) loads four cases
positioned **relative to seed time**, so the derived deadline states are the
same whenever you seed: one comfortably inside its window, one about to
breach the seven-day acknowledgement, one that already has (and is therefore
already accruing the feedback failure too), and one handled properly end to
end and concluded. Everything is built through the domain functions, so the
seeded database satisfies the same invariants as a live one.

---

## Deploy notes

`npm run build` compiles the client to `dist/client` and the server to
`dist/server`; `npm start` runs one Node process that serves the API and the
built SPA (client routes fall through to `index.html`). Point a persistent
volume at `DATABASE_PATH`. **Put it behind TLS and set `COOKIE_SECURE=true`**
— a reporting channel over plain HTTP is worse than none, because it invites
people to type the thing that could cost them their job into a request
anyone on the path can read. `npm run backup` takes an online, consistent
SQLite snapshot; treat those snapshots as the most sensitive file the
organisation holds.

---

## Out of scope (deliberately)

- **Attachments.** A whistleblower's photo of a document carries EXIF, a
  device id and often a filename with their name in it, and stripping all of
  that reliably is a project. Until it is done properly, "describe it in
  text" is the honest answer.
- **Named case handlers with per-case assignment.** § 17 Abs. 1 HinSchG wants
  reports reaching *designated* people; with the single shared login the
  designated person is whoever holds it. Wire `IDENTITY_URL` to PS-01 and
  every action lands in the trail under a real name — but this module has no
  per-case access control, so everyone who can sign in can read every case.
- **Email or SMS notification of the reporter.** Any outbound channel is an
  identifier, and the point of the access code is that there is none. The
  reporter comes back and looks.
- **External reporting channels** (§ 19 ff. HinSchG — the BMJ office, BaFin,
  the Bundeskartellamt). Reporters keep the right to go to them directly;
  this module neither forwards to them nor pretends to.
- **Anonymity at the network layer.** The module records no IP, but the
  reverse proxy in front of it and the corporate network in between still
  see the connection. A channel reachable only from the office LAN is not
  anonymous no matter what this code does — document that, or publish it
  externally.
- **Multi-tenancy**, **retaliation-case management** (§ 36 HinSchG), **risk
  scoring**, and **statistics beyond the outstanding-obligation counters**.
- **Rate limiting beyond the two per-IP buckets** — add more at the edge.

---

## Platform integration (optional)

When `AUDIT_URL` (+ `PLATFORM_SERVICE_TOKEN`) is set, this module records the
**fact** of each case action on
[PS-07 Audit Log](../../platform/ps-07-audit-log) via the shared
[`@0815software/platform-clients`](../../platform/clients) package — the ref
and the verb, never the report text. When `IDENTITY_URL` is set, handler
logins are verified against [PS-01 Identity](../../platform/ps-01-identity)
instead of the local pair. Best-effort and opt-in — unset, the module runs
standalone. See `server/platform.ts` and `server/sso.ts`.

---

MIT © 2026 0815software. See [LICENSE](./LICENSE).
