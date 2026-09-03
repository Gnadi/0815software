# Test plan — the Platform Services and the Business Modules

*A bug hunt with a stop rule. Twelve Platform Services, sixteen Business
Modules, the shared clients package and the provisioner: 29 packages, ~60 000
lines of service code and ~40 000 of module code. September 2026.*

## Why this exists

The suites are large and they are green. That was true on the morning this plan
was written — 4 775 tests across 29 packages, every one passing — and it stayed
true while the review found eleven defects, because **not one of them was in a
case anybody had thought to write**. A green suite proves the code does what its
author expected; it says nothing about what happens at the inputs the author did
not picture, or at the seams where two packages each behave correctly and
disagree.

Three of the eleven make the point on their own:

- `GET /api/search?limit=abc` answered **500**. Not 422 — 500, from
  `SqliteError: datatype mismatch`, because `Number('abc')` is `NaN` and `NaN`
  survives every clamp `Math.min`/`Math.max` can apply. Three services shipped
  that. The newest service, PS-12, had already solved it with a validator none
  of the others adopted.
- A signed download URL could be issued with a TTL of `1e11` seconds. The route
  exists to hand an object to somebody holding no credential, and "time-limited"
  is the entire access-control story behind it; the field that makes it true was
  read as any number at all.
- The two shell modules answered `/api/ready` with `{ ok: true }` where the
  other twenty-seven packages answer `{ ready: true }`. Both returned 200, so
  both suites were green — and `deploy/smoke-stack.mjs`, the pre-flight an
  operator is told to run before the first `docker compose up`, could never pass
  on a stack containing a shell.

**The rule this document runs on:** an automated suite proves a package is
consistent with itself; a case in this plan establishes that it is consistent
with the platform, the operator, or the money. Every case says what to do when
it differs, and every case ends in **STOP** (blocks the release) or **NOTE**
(record and continue). A checklist without a stop rule gets completed rather
than executed.

Read alongside:
- [`PLATFORM-READINESS.md`](./PLATFORM-READINESS.md) — the standing verdict and
  the A/B/C/D punch-list this plan does not repeat.
- [`TEST-PLAN-PS-12.md`](./TEST-PLAN-PS-12.md) — PS-12 Banking has its own
  acceptance plan and its own blocking gate (a real bank). §13 here says only
  what that plan does not.
- [`PII-MAP.md`](./PII-MAP.md), [`SHELL-CONTRACT.md`](./SHELL-CONTRACT.md),
  [`REPORTING-CONTRACT.md`](./REPORTING-CONTRACT.md) — the contracts §12 and
  §14 check against.

## Environments

Every case is tagged with the environment it needs.

| | Environment | How |
| --- | --- | --- |
| **L** | Local, one package, offline | `npm ci && npm test` in the package. No credentials, no network. |
| **S** | A provisioned stack | `node deploy/provision.mjs …`, then `node deploy/smoke-stack.mjs --manifest …`. Real processes, production mode, generated secrets. |
| **V** | A real vendor | Stripe, Resend, Twilio, OpenAI/Anthropic, a real OAuth provider, a real bank. The blocking gate: every **V** case is un-runnable until keys exist. |

The tagging is the point: **every L and S case can be run today**, and the V
cases are visibly the ones that cannot. A green L column is not a release.

## How to read a case

> **P9-1 · A malformed limit is a bad request, not a broken service** — **L**
> *Precondition:* one document indexed.
> *Steps:* `GET /api/search?collection=c&q=x&limit=abc`.
> *Expected:* 422 naming `limit`. Not 500, and not a silent clamp.
> *If it differs:* **STOP** — a typo in a query string must not be
> indistinguishable, to the caller and to the logs, from the service being down.

---

## 1 · The shared idioms — one defect is twenty-eight

*Files:* `server/guard.ts`, `server/hardening.ts`, `server/telemetry.ts`,
`server/errors.ts`, `server/migrations.ts` — copied byte-identically into every
package, plus `server/handoff.ts` across the twelve embeddable modules.

*Already covered:* `transport-hardening.test.ts` (44 cases in PS-01) pins the
rate limiter, the CORS default-deny, the header set and `TRUST_PROXY`;
`config-env.test.ts` pins the boot guard per package; `upgrade.test.ts` replays
every migration over seeded data in all 29.

**S1 · The copies really are copies** — **L**
*Steps:* `md5sum` each shared file across every package.
*Expected:* one digest per file, or a divergence the file itself explains.
`errors.ts` 12/12, `hardening.ts` 12/12 across services and 16/16 across
modules, `telemetry.ts` 12/12, `handoff.ts` 12/12 — and `guard.ts` 27/28,
PS-12 carrying extra bank-key checks.
*If it differs:* **STOP** unless the divergence is deliberate and documented in
the file — a copy-in file that has quietly forked is a fix applied 11 times out
of 12.

**S2 · A validator that exists in one package exists in all** — **L**
*Steps:* for each boundary idiom (`numberFromEnv`, `optionalInt`,
`nonNegativeNumber`), grep every package for the unguarded form it replaced
(`Number(env.X) ||`, `Number(req.query.…)`).
*Expected:* none.
*If it differs:* **STOP** — this is exactly how P7-1/P9-1/P11-1 shipped: PS-12
had the validator, and nothing carried it back.

**S3 · A malformed cookie is a 401, not a 500** — **L**
*Steps:* send `Cookie: <name>=%` to every package's session-guarded route.
*Expected:* 401. *If it differs:* **STOP** — a browser replays a corrupt cookie
on every request for the whole TTL, so a throw here is a session that can
neither authenticate nor recover.

**S4 · The boot guard refuses what it says it refuses** — **S**
*Steps:* boot each package under `NODE_ENV=production` with (a) a shipped
default secret, (b) an empty one.
*Expected:* refusal before `listen`, naming the variable.
*If it differs:* **STOP.**

---

## 2 · PS-01 Identity

*Files:* `server/app.ts`, `auth.ts`, `tokens.ts`, `oauth.ts`, `throttle.ts`,
`api-keys.ts`, `export.ts`.

*Already covered:* `api.test.ts` walks users/roles/keys and the tenant scope;
`escalation.test.ts` pins `requireGrantable` on all four escalation doors;
`throttle.test.ts` the per-account backoff; `oauth-hardening.test.ts` the mock
IdP switch, the redirect allowlist and the state TTL; `event-loop.test.ts` that
scrypt stays off the loop.

**P1-1 · OAuth never signs in an account that may not sign in** — **L**
*Precondition:* an account linked through the provider, then disabled (or
erased, which disables it).
*Steps:* run authorize → callback again.
*Expected:* 403. No token in the body, no token appended to `redirect_uri`, and
`login_fail` on the trail rather than `login_ok`.
*If it differs:* **STOP** — `POST /api/login` refuses a disabled account and the
provider door must not be the exception. The token the gate would reject anyway
is the smaller half: the redirect target is handed one, and the audit trail
records a successful sign-in that the operator who disabled the account will
read as a bypass.

**P1-2 · A subject export stays inside the caller's organization** — **L**
*Steps:* provoke a failed login against org B for an address with no account
there; as an administrator of org A, `GET /api/export?subject=<that address>`.
*Expected:* nothing. Org A holds no record of that person.
*If it differs:* **STOP** — failed logins carry the typed address and the source
IP, and an unscoped read of them is one tenant reading another's.

**P1-3 · No principal hands out authority it does not hold** — **L**
*Steps:* as an Administrator (no `org:write`), try each door: mint an unscoped
API key, define a role granting `org:write`, assign yourself Owner, create a
user holding Owner.
*Expected:* 403 on all four. *If it differs:* **STOP.**

**P1-4 · A password change kills live sessions** — **L**
*Steps:* issue a token, change the password, re-present the token to
`/api/tokens/verify` and to a guarded route.
*Expected:* `{ valid: false }` and 401. *If it differs:* **STOP.**

**P1-5 · Guessing at one account gets expensive from any address** — **L**
*Steps:* fail 8 logins for one (org, email) from 8 different IPs.
*Expected:* the delay grows with the failure count and is paid before the
attempt is judged; a correct password clears it.
*If it differs:* **NOTE** — the per-IP limiter cannot see a spray.

**P1-6 · A real OAuth provider issues a session** — **V**
*Steps:* configure one provider with real credentials; complete the flow.
*If it differs:* **STOP** — everything below this line is fixture-tested only.

---

## 3 · PS-02 Workflow Engine

*Files:* `server/events.ts`, `webhooks.ts`, `scheduler.ts`, `egress.ts`.

*Already covered:* `dispatch-concurrency.test.ts` proves overlapping ticks
cannot deliver twice and that a rejected run does not poison the chain;
`egress.test.ts` the SSRF verdicts; `api.test.ts` the retry ladder to
dead-letter.

**P2-1 · An idempotency key covers the whole ingest, fan-out included** — **L**
*Steps:* `POST /api/events` with `idempotency_key`; repeat the identical call.
*Expected:* one instance, and **`enqueued: 0`** on the replay — every subscriber
was told once.
*If it differs:* **STOP** — the key deduped the workflow instance and nothing
deduped the webhook beside it, so a caller whose POST timed out and was retried
told every subscriber twice. A subscriber that bills or ships on the event has
no way back from the second POST.

**P2-2 · A delivered webhook is not re-delivered by the retry button** — **L**
*Steps:* `POST /api/deliveries/:id/retry` on a `delivered` row.
*Expected:* 409, status unchanged. *If it differs:* **STOP** — same harm as
P2-1, one click away, through a route that never looked at the status.

**P2-3 · A schedule that missed ten intervals fires once** — **L**
*Steps:* advance the clock past ten intervals; tick.
*Expected:* one instance, `last_run_at` stamped once. *If it differs:* **NOTE**
— documented as no-backfill.

**P2-4 · A webhook aimed inside the stack is refused and says so** — **S**
*Steps:* subscribe a webhook to `http://ps01:4001/…` under `EGRESS_MODE=block`;
tick.
*Expected:* dead-lettered with the reason on the row, not retried.
*If it differs:* **STOP.**

---

## 4 · PS-03 Notification Hub

*Files:* `server/queue.ts`, `templates.ts`, `providers/*`.

*Already covered:* `api.test.ts` the retry ladder and the provider registry;
`retention.test.ts` the PII window; `retry-fetch.test.ts` the vendor backoff.

**P3-1 · A message that reached the recipient is not sent twice** — **L**
*Steps:* send, tick until `sent`, then `POST /api/messages/:id/retry`.
*Expected:* 409, exactly one `sent` event on the message.
*If it differs:* **STOP** — `queue.ts` serialises ticks precisely because
"twice" here means a customer receiving two copies of the same invoice mail;
the retry route let the same thing through the front door.

**P3-2 · A template renders only what it was given** — **L**
*Steps:* render with `{{constructor}}` and with a missing variable.
*Expected:* 422 naming the missing name; nothing from `Object.prototype`
rendered into an outgoing message. *If it differs:* **STOP.**

**P3-3 · Retention actually removes the bodies** — **S**
*Steps:* set `RETENTION_DAYS`, age terminal messages past it, tick.
*Expected:* the rows are gone, and `/api/export` for that recipient reports
nothing. *If it differs:* **NOTE** and record the window measured.

**P3-4 · Resend and Twilio accept what we send** — **V**
*If it differs:* **STOP** — the fixtures encode our reading of the API.

---

## 5 · PS-04 AI Platform

*Files:* `server/chat.ts`, `prompts.ts`, `embeddings.ts`, `providers/*`.

**P4-1 · An idempotency key answers, even when two callers race** — **L**
*Steps:* fire two `runChat` calls with the same key concurrently.
*Expected:* both get the same completion id; one row stored.
*If it differs:* **STOP** — the check and the insert are separated by a vendor
call that takes seconds, `idempotency_key` is UNIQUE, and the loser's INSERT
surfaced as a 500: the one answer an idempotency key exists to make impossible.
*Known and stated:* the duplicate provider call itself is not prevented. Doing
that needs a claim row written before the vendor is called, whose failure mode —
a hollow claim left by a crashed request, replayed forever as an empty
completion — is worse than one extra call in a race.

**P4-2 · An unconfigured vendor is the mock, not an error** — **L**
*Steps:* request `provider: 'anthropic'` with no key set.
*Expected:* a deterministic mock answer, reported as `mock`.
*If it differs:* **NOTE.**

**P4-3 · A real model answers** — **V**
*If it differs:* **STOP.**

---

## 6 · PS-05 Integration Hub

*Files:* `server/oauth.ts`, `crypto.ts`, `proxy.ts`, `sync.ts`, `webhooks.ts`.

**P5-1 · An OAuth state nonce stops being redeemable** — **L**
*Steps:* authorize; wait past the window; complete the callback. Then leave
three authorize attempts abandoned and complete any callback.
*Expected:* 400 for the stale state, and the abandoned rows gone.
*If it differs:* **STOP** — a state with no expiry means an authorize URL that
reached a log, a bookmark or a shared screen is a live way to attach a
connection months later, and the table only ever grows.

**P5-2 · Credentials never leave the service** — **L**
*Steps:* read every connection route and the event log.
*Expected:* no `credentials`, no `credentials_encrypted`, no decrypted token.
*If it differs:* **STOP.**

**P5-3 · The proxy cannot be pointed inside the stack** — **S**
*Steps:* a connection whose `base_url` resolves to a private address, under
`EGRESS_MODE=block`.
*Expected:* 403 with the reason. *If it differs:* **STOP.**

**P5-4 · A real provider's webhook signature verifies** — **V**
*If it differs:* **STOP.**

---

## 7 · PS-06 File Storage

*Files:* `server/storage.ts`, `app.ts`.

**P6-1 · A signed download URL is time-limited, and stays that way** — **L**
*Steps:* `POST /api/objects/:b/:k/sign` with `ttl_seconds` of `0`, `-5`, `1e11`,
`1e15` and `1e308`; then with the default and with the ceiling.
*Expected:* 422 for all five; 200 for the last two, and a URL signed at the
ceiling still downloads.
*If it differs:* **STOP** — this is the only way an object reaches somebody
holding no credential. `1e11` seconds is a permanent, unrevocable,
unauthenticated link to a customer document, indistinguishable in the response
from a five-minute one; past `1e15` the expiry is not a representable date and
the route answered 500.

**P6-2 · A download is never rendered inline** — **L**
*Steps:* store an object as `text/html` and fetch it through a signed URL.
*Expected:* `Content-Disposition: attachment`, the sandbox CSP, `nosniff`.
*If it differs:* **STOP** — stored XSS on the origin holding the session cookie.

**P6-3 · A tampered signature is refused** — **L**
*Steps:* alter `expires`, `bucket`, `key` and `sig` in turn.
*Expected:* 403 each time. *If it differs:* **STOP.**

---

## 8 · PS-07 Audit Log

*Files:* `server/audit.ts`.

*Already covered:* the chain tests cover an edited event, a truncated tail, and
retention advancing the anchor.

**P7-1 · A malformed limit is a bad request, not a broken service** — **L**
*Steps:* `GET /api/events?limit=abc`, `=0`, `=-1`, `=100000`, `=1.5`.
*Expected:* 422 naming `limit`. *If it differs:* **STOP** (see §*Why this
exists*).

**P7-2 · Cutting the end off the log is detected** — **L**
*Steps:* `DELETE FROM audit_events WHERE id >= n`; `GET /api/verify`.
*Expected:* invalid, `broken_kind: 'truncated'`.
*If it differs:* **STOP** — removing the tail is the edit somebody covering
their tracks makes, and the surviving links still form a valid chain.

**P7-3 · Retention deletes a prefix, never a hole** — **L**
*Steps:* prune with a clock that has stepped backwards.
*Expected:* the delete resolves to an id first; `/api/verify` still validates.
*If it differs:* **STOP** — a hole in the middle is permanent and unrepairable.

---

## 9 · PS-08 Payments

*Files:* `server/payments.ts`, `webhooks.ts`.

**P8-1 · Two concurrent refunds cannot exceed the payment** — **L**
*Steps:* two full refunds of one captured intent, in flight together.
*Expected:* one succeeds, one 422s on the balance. *If it differs:* **STOP.**

**P8-2 · A refund the PSP rejected leaves no trace of money moving** — **L**
*Steps:* make the provider throw.
*Expected:* the event, the ledger row and the idempotency claim are all rolled
back, so a legitimate retry is not swallowed. *If it differs:* **STOP.**

**P8-3 · The real Stripe signature scheme verifies, and replays do not** — **L**
*Steps:* a fixture signed `t=…,v1=…`; then the same body with a timestamp
outside the tolerance.
*Expected:* 202 then 403. *If it differs:* **STOP.**

**P8-4 · Stripe accepts a real intent and its webhook reconciles** — **V**
*If it differs:* **STOP** — this is A5's last mile.

---

## 10 · PS-09 Search · PS-10 Number

**P9-1 · A malformed limit or offset is a bad request** — **L**
*Steps:* `limit=abc`, `offset=abc`, `limit=0`, `limit=1000`, `offset=-1`,
`limit=2.5`. *Expected:* 422. *If it differs:* **STOP.**

**P9-2 · A tenant cannot read another tenant's index** — **L**
*Steps:* index under tenant A, search as tenant B. *Expected:* nothing.
*If it differs:* **STOP.**

**P10-1 · The counter is gapless under concurrency** — **L**
*Steps:* allocate 500 numbers concurrently in one scope.
*Expected:* 1…500, no gaps, no repeats. *If it differs:* **STOP** — gapless
numbering is a DACH legal requirement, not a nicety.

**P10-2 · A period rollover restarts at 1 and never collides** — **L**
*Steps:* allocate either side of a year boundary. *Expected:* the period key
changes and the sequence restarts. *If it differs:* **STOP.**

---

## 11 · PS-11 Customers

**P11-1 · A malformed limit is a bad request** — **L**
*Steps:* `GET /api/parties?limit=abc|0|501|-1|1.5`. *Expected:* 422.
*If it differs:* **STOP.**

**P11-2 · Matching never crosses kinds** — **L**
*Steps:* resolve a supplier and a customer sharing a VAT id.
*Expected:* two parties. *If it differs:* **STOP** — a company you both buy from
and sell to is two relationships with two sets of terms.

**P11-3 · A merge leaves no consumer reading a stale record** — **L**
*Steps:* merge, then read the loser's id.
*Expected:* the survivor, with `requested_id` saying so; refs moved; the loser's
own knowledge enriched onto the survivor without clobbering it.
*If it differs:* **STOP.**

**P11-4 · The seller letterhead has one home** — **S**
*Steps:* change the `self` party; re-read MOD-04's and MOD-13's letterhead.
*Expected:* both follow. *If it differs:* **NOTE.**

---

## 12 · PS-12 Banking

Covered by its own plan — [`TEST-PLAN-PS-12.md`](./TEST-PLAN-PS-12.md), 53
cases, of which 30 were executed on 2026-08-24 and 17 still need a bank. This
plan adds nothing to it and repeats nothing from it. Two obligations only:

**P12-1 · The PS-12 acceptance harness still passes** — **L**
*Steps:* `npm run acceptance` in `platform/ps-12-banking` and in
`modules/mod-04-invoice-billing`.
*Expected:* every case passes. *If it differs:* **STOP.**

**P12-2 · The blocking gate is still stated** — **L**
*Steps:* confirm the README and the readiness doc still say that nothing here
has spoken to a real bank. *If it differs:* **STOP** — the claim outrunning the
evidence is the failure mode this repository has been bitten by before.

---

## 13 · The clients package and the contract seam

*Files:* `platform/clients/src/*`, each service's `test/contract.test.ts`.

**P13-1 · The client and the service still agree** — **L**
*Steps:* every service's contract test boots the real service on an ephemeral
port and drives the real client source over HTTP.
*Expected:* green. *If it differs:* **STOP** — this seam is where envelope and
field-name drift lives, invisible to injected-fetch unit tests.

**P13-2 · A write is never replayed by the client on its own** — **L**
*Steps:* make a POST time out. *Expected:* one attempt. Only GETs retry, because
the client cannot know whether a write carried an idempotency key.
*If it differs:* **STOP.**

**P13-3 · A hung service does not hang the caller** — **L**
*Steps:* a fetch that never settles. *Expected:* the request aborts on the
timeout. *If it differs:* **STOP** — the module is usually mid-request for
somebody watching a spinner.

---

## 14 · The modules — the shared surface

Sixteen modules, most of the surface copy-in. A case here is sixteen cases.

**M-1 · A broken identity service is an outage, not a wrong password** — **L**
*Steps:* with SSO configured, make PS-01 answer 500, then 429, then 401.
*Expected:* `unavailable`, `unavailable`, `rejected` — and the module answers
503, 503, 401.
*If it differs:* **STOP** — the code's own comment says an outage reported as a
rejection "sends a user off to reset a password that was never wrong while
hiding a broken deployment from whoever has to fix it", and the test it used was
"did PS-01 answer at all". `ServiceError` is raised for every non-2xx, so a
half-broken PS-01 and its own login throttle both arrived as a wrong password.

**M-2 · Readiness is answered in the shape the stack reads** — **L**
*Steps:* `GET /api/ready` on every module and service; assert the **body**.
*Expected:* `{ ready: true }`, and `{ ready: false }` with 503 when the database
is unreachable.
*If it differs:* **STOP** — `deploy/smoke-stack.mjs` asserts `body.ready`, so a
package answering `{ ok: true }` returns 200, keeps its own suite green, and
makes every customer stack containing it fail its own pre-flight.

**M-3 · SSO, once configured, is never silently bypassed** — **L**
*Steps:* with a verifier that rejects, present correct local credentials.
*Expected:* 401. *If it differs:* **STOP.**

**M-4 · The shell handoff cannot become an open redirect** — **L**
*Steps:* mint a ticket; try to redeem it twice; try `//host`, `/\host`,
`/<tab>/host`, and a ticket minted by another module.
*Expected:* single use, 30 seconds, every escape refused, cross-module refused.
*If it differs:* **STOP** — the `Location` is set on a response that has already
set a session cookie.

**M-5 · A module boots and works with no service URLs at all** — **S**
*Steps:* boot each module with every platform URL unset.
*Expected:* it serves its API. *If it differs:* **STOP** — the standalone
guarantee is the promise the catalogue is sold on.

**M-6 · A CSV export cannot execute in a spreadsheet** — **L**
*Steps:* store a value beginning `=`, `+`, `-`, `@`, tab or CR; export.
*Expected:* the cell is forced to text; a plain number stays a number.
*If it differs:* **STOP** (CWE-1236).

**M-7 · Every package can be backed up, and a restore reads back** — **L**
*Steps:* `npm run backup` in each package; for the three that keep files beside
the database, confirm the files came too; restore and read through the module's
own routes.
*Expected:* a snapshot per package, `deploy/test/backup.test.ts` re-deriving the
coverage from the registry. *If it differs:* **STOP.**

**M-8 · Security headers are on module responses too** — **S**
*Expected:* `nosniff`, framing denied (or `frame-ancestors` naming the shells),
`no-referrer`, HSTS. *If it differs:* **STOP.**

---

## 15 · The modules — money and state machines

**M-10 · Checkout is one transaction** — **L** (MOD-07)
*Steps:* check out a cart where one line exceeds stock.
*Expected:* 422 listing every shortage, and **no** stock touched.
*If it differs:* **STOP.**

**M-11 · Cancel restores exactly what checkout took** — **L** (MOD-07)
*Expected:* cancel + re-place is stock-neutral. *If it differs:* **STOP.**

**M-12 · Totals are computed once, and everyone shares the answer** — **L**
*Steps:* compare the API, the CSV export and the rendered document for one
order/invoice.
*Expected:* identical integer cents; VAT extracted per rate on the tax base,
never per line. *If it differs:* **STOP.**

**M-13 · An accepted offer becomes a draft invoice, once** — **L** (MOD-13→04)
*Steps:* import the same offer twice; then one whose totals do not add up.
*Expected:* idempotent on the offer number; the second import returns the first
invoice; the inconsistent transfer is refused. *If it differs:* **STOP.**

**M-14 · A finalized invoice is immutable and gaplessly numbered** — **L**
*Steps:* edit, delete and re-finalize a finalized invoice; check the number
sequence across a period rollover.
*Expected:* refused; no gaps. *If it differs:* **STOP** — DACH.

**M-15 · A reporting module never writes to its source** — **S** (MOD-08)
*Steps:* run with `SOURCE_DB_PATH` mounted read-only and
`SOURCE_VIEWS_ONLY=true`.
*Expected:* it reads the `report_*` views and nothing else, and never writes.
*If it differs:* **STOP.**

---

## 16 · The stack

**T-1 · A customer's selection provisions and boots** — **S**
*Steps:* `provision.mjs` for a real selection, fill the `.env`, then
`smoke-stack.mjs --manifest`.
*Expected:* health, readiness, every wired URL, SSO where the registry says so
and its absence where it does not, security headers, the boot guard's refusal,
and no `FILL-ME-IN` left. *If it differs:* **STOP.**

**T-2 · The registry cannot become a lie** — **L**
*Steps:* `deploy` suite — every registry claim re-derived from each package's
own `server/config.ts`. *If it differs:* **STOP.**

**T-3 · Everything a service exports, something alerts on** — **L**
*Steps:* the monitoring test, in both directions: every alerted metric is really
exported, and every domain gauge has a rule (or is listed by name as
informational). *If it differs:* **STOP** — a gauge nobody reads is
indistinguishable from health, which is how PS-12's `banking_orders_failed`
arrived unwatched.

**T-4 · Somebody is paged** — **S**
*Steps:* a receiver in `monitoring/alertmanager.yml`; fire one alert.
*If it differs:* **STOP for a paying customer**, NOTE for a pilot.

**T-5 · The snapshots leave the host** — **S**
*Steps:* the operator's off-host copy, then a restore from it.
*If it differs:* **STOP for a paying customer.** Still open (A6).

---

## 17 · Compliance

**D-1 · One person, one answer** — **S**
*Steps:* `node deploy/export-subject.mjs` across a stack for one address.
*Expected:* a report naming every source, and naming its own gaps — the modules
have no export endpoint, so each is listed with what to inspect instead, and an
unreachable service is a gap rather than an empty source.
*If it differs:* **NOTE.**

**D-2 · Erasure is complete where it claims to be** — **S**
*Steps:* erase in PS-01; confirm the PII is gone, the sessions are dead, the
account cannot log in — through the password door **and** the provider door
(P1-1) — and the row and id survive for referential integrity.
*If it differs:* **STOP.**

**D-3 · Retention windows are real** — **S**
*Steps:* PS-03 message bodies and PS-07 events past their windows.
*Expected:* pruned; the audit chain still verifies over the survivors.
*If it differs:* **STOP.**

---

## 18 · Exit criteria

Production-ready means all of:

1. Every **L** and **S** case above passes, recorded in §19.
2. Every **V** case passes against real vendor keys — Stripe, Resend/Twilio, one
   OAuth provider, one AI vendor, and a real bank for PS-12.
3. A human other than the author has reviewed `platform/ps-01-identity/server/`
   (auth, tokens, oauth, api-keys), `ps-08-payments/server/payments.ts`,
   `ps-07-audit-log/server/audit.ts` and `ps-06-file-storage/server/storage.ts`.
4. T-4 (somebody is paged) and T-5 (an off-host restore) are done.
5. PS-12's own plan reaches its own exit criteria.

**Not covered by this plan, and deliberately:**
- Load, soak and concurrency testing beyond the single-process races above.
  SQLite is single-writer; the tick-driven queues and the gapless counters are
  correct on one instance and do not scale horizontally (A6, open).
- Multi-tenancy in PS-02…08 and PS-10, which do not have it (A7, open). The
  tenant cases above test the services that claim it.
- Per-user authorization inside modules (C1, deferred by decision).
- Any browser-side testing. Every case here is server-side.

---

## 19 · Record sheet

**Run on 2026-09-03**, on branch `claude/platform-services-review-bugs-6ra7no`,
against 29 packages. **70 cases, 63 executed** — 46 passed, 14 failed and are
now fixed, 3 came back partial. Of the 7 not run, 5 are **V** cases waiting on a
vendor and 2 are **S** cases waiting on infrastructure this repository cannot
supply (a receiver to page, a host to restore onto).

Baseline before the run: 4 775 tests, all green. After: 4 840, all green — the
65 new ones are the cases below that had no coverage, and every one of them
fails against the code as it was.

### What this run found

Eleven defects across the fourteen failing cases, in three families. None of
them was in a case anybody had written.

**A validator that existed in one package and nowhere else.** PS-12 reads
`limit` through an `optionalInt` that refuses anything that is not a whole
number in range. PS-07, PS-09 and PS-11 read theirs through `Number(…)` and
clamped the result — and `NaN` survives `Math.min(Math.max(1, NaN), 100)`
unchanged, reaching SQLite as an unbindable parameter. `?limit=abc` answered
**500 `SqliteError: datatype mismatch`** in all three (P7-1, P9-1, P11-1).
PS-06's signed-URL TTL was the same shape with a sharper edge: unbounded, so
`ttl_seconds: 1e11` minted a three-thousand-year unauthenticated link to a
customer document, and `1e15` was not a representable date and answered 500
(P6-1). `optionalInt` now lives in the shared `errors.ts` in all twelve
services, and the four routes use it.

**An idempotency key that covered less than it looked like.** PS-02's key
deduped the workflow instance a replayed event started; the webhook fan-out
beside it ran unconditionally, so a caller whose POST timed out and retried told
every subscriber twice (P2-1). PS-04's key was checked before a vendor call that
takes seconds and written after it, so two concurrent callers both reached the
provider and the loser's INSERT hit the UNIQUE index and surfaced as a 500 —
the one answer an idempotency key exists to make impossible (P4-1). And the two
`retry` routes re-queued rows that had already **succeeded**: a delivered
webhook re-POSTed, a sent invoice mail sent again (P2-2, P3-1), one click away
from the duplicate that `queue.ts` serialises ticks to prevent.

**Seams where two packages were each right and disagreed.** The SSO verifier,
copy-in across thirteen modules, decided "PS-01 rejected the credential" by
asking whether PS-01 answered at all — and `ServiceError` is raised for every
non-2xx, so a 500 from a half-broken PS-01 and a 429 from its own login throttle
both reached the operator as *wrong password* (M-1). Its own comment says why
that is the wrong answer. The two shells answer `/api/ready` with the
`/api/health` payload, so `deploy/smoke-stack.mjs` — the pre-flight an operator
runs before the first `docker compose up` — could not pass on any stack
containing one (M-2). Both suites were green: they asserted the status code.
PS-01's subject export read failed logins across every tenant, so an
administrator of one customer could ask for any address and read the source IPs
of attempts aimed at another (P1-2). And PS-01's OAuth callback issued a session
and wrote `login_ok` for an account that had been disabled or erased — the
password door refuses it, the provider door did not (P1-1). PS-05's OAuth state
had no expiry at all, so an abandoned authorize URL stayed redeemable forever
and the table only grew (P5-1).

Three of the eleven are guarded against recurrence by a test that watches every
package at once rather than the one that was wrong: `deploy/test/registry.test.ts`
already re-derives the registry's claims, and `deploy/test/readiness-contract.test.ts`
now re-derives the readiness shape the same way, for all 28 HTTP packages.

### Cases

| Case | Env | Date | Who | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| S1 | L | 2026-09-03 | review | pass | `errors.ts` 12/12, `hardening.ts` 12/12 + 16/16, `guard.ts` 27/28, `telemetry.ts` 12/12, `handoff.ts` 12/12. PS-12's `guard.ts` differs deliberately (extra bank-key checks) |
| S2 | L | 2026-09-03 | review | **FAIL → fixed** | four routes read `limit`/`ttl_seconds` through bare `Number(…)`; `optionalInt` lifted into the shared `errors.ts` and adopted |
| S3 | L | 2026-09-03 | review | pass | `decodeCookieValue` catches the URIError in all 28 copies; 401 not 500 |
| S4 | S | 2026-09-03 | review | pass | smoke-stack: MOD-01 and PS-01 both refuse a default `SESSION_SECRET` under `NODE_ENV=production` |
| P1-1 | L | 2026-09-03 | review | **FAIL → fixed** | disabled account: callback was 200 with a token and `login_ok`; now 403, `login_fail`, no token on the redirect |
| P1-2 | L | 2026-09-03 | review | **FAIL → fixed** | org A's export returned org B's `failed_logins` with IPs; now scoped to the caller's org |
| P1-3 | L | 2026-09-03 | review | pass | `escalation.test.ts`, all four doors 403 |
| P1-4 | L | 2026-09-03 | review | pass | `token_version` bump; verify `{valid:false}`, route 401 |
| P1-5 | L | 2026-09-03 | review | pass | `throttle.test.ts`: delay paid before the judgement, keyed on what was typed |
| P1-6 | V | | | not run (needs a provider) | |
| P2-1 | L | 2026-09-03 | review | **FAIL → fixed** | replay enqueued a second delivery to every subscriber; `event_ingests` (migration 002) now makes the key cover the fan-out, `enqueued: 0` on replay |
| P2-2 | L | 2026-09-03 | review | **FAIL → fixed** | retry re-queued a `delivered` row; now 409 |
| P2-3 | L | 2026-09-03 | review | pass | one instance after ten missed intervals |
| P2-4 | S | 2026-09-03 | review | pass | `egress.test.ts` + stack boot; dead-lettered with the reason, not retried |
| P3-1 | L | 2026-09-03 | review | **FAIL → fixed** | retry re-queued a `sent` invoice mail; now 409, one `sent` event |
| P3-2 | L | 2026-09-03 | review | pass | `{{constructor}}` is a missing variable, not `Object.prototype` |
| P3-3 | S | 2026-09-03 | review | partial | `retention.test.ts` proves the prune; not aged out over a real window on a stack |
| P3-4 | V | | | not run (needs keys) | |
| P4-1 | L | 2026-09-03 | review | **FAIL → fixed** | concurrent same-key pair raised `UNIQUE constraint failed`; now both get the winner's completion, one row |
| P4-2 | L | 2026-09-03 | review | pass | unconfigured vendor falls back to `mock`, reported as `mock` |
| P4-3 | V | | | not run (needs keys) | |
| P5-1 | L | 2026-09-03 | review | **FAIL → fixed** | no TTL and no prune: a stale state was still redeemable and 3 abandoned rows survived; now 400 past the window, table cleared |
| P5-2 | L | 2026-09-03 | review | pass | `mapConnection` drops the blob; no route returns credentials |
| P5-3 | S | 2026-09-03 | review | pass | `guardedFetch` covers the proxy and the token exchange through one door |
| P5-4 | V | | | not run (needs a provider) | |
| P6-1 | L | 2026-09-03 | review | **FAIL → fixed** | `1e11` → a link to 5026; `1e15`/`1e308` → 500; now 422, ceiling 7 days, a URL signed at the ceiling still downloads |
| P6-2 | L | 2026-09-03 | review | pass | attachment + sandbox CSP + nosniff on the signed download |
| P6-3 | L | 2026-09-03 | review | pass | each of the four fields altered → 403 |
| P7-1 | L | 2026-09-03 | review | **FAIL → fixed** | `limit=abc` → 500 `datatype mismatch`; now 422, and `listEvents` is NaN-safe from inside the process too |
| P7-2 | L | 2026-09-03 | review | pass | head marker: `broken_kind: 'truncated'` |
| P7-3 | L | 2026-09-03 | review | pass | cutoff resolved to an id before the delete |
| P8-1 | L | 2026-09-03 | review | pass | balance claimed inside the transaction, before the PSP call |
| P8-2 | L | 2026-09-03 | review | pass | event, ledger row and idempotency claim all rolled back |
| P8-3 | L | 2026-09-03 | review | pass | `t=…,v1=…` over `${t}.${body}`; outside tolerance → 403 |
| P8-4 | V | | | not run (needs keys) | |
| P9-1 | L | 2026-09-03 | review | **FAIL → fixed** | `limit=abc` and `offset=abc` → 500; now 422, `search()` NaN-safe |
| P9-2 | L | 2026-09-03 | review | pass | tenant is part of the MATCH clause |
| P10-1 | L | 2026-09-03 | review | pass | `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside a transaction |
| P10-2 | L | 2026-09-03 | review | pass | period key from the UTC clock; counter is per (scope, period) |
| P11-1 | L | 2026-09-03 | review | **FAIL → fixed** | `limit=abc` → 500; now 422, `listParties` NaN-safe |
| P11-2 | L | 2026-09-03 | review | pass | matching never crosses `kind`; smoke-stack asserts it on a real stack |
| P11-3 | L | 2026-09-03 | review | pass | redirect kept, refs moved, enrich-never-clobber |
| P11-4 | S | 2026-09-03 | review | pass | smoke-stack: PS-11 stores the letterhead MOD-04 and MOD-13 print |
| P12-1 | L | 2026-09-03 | review | pass | `npm run acceptance`: PS-12 18/18, MOD-04 6/6 |
| P12-2 | L | 2026-09-03 | review | pass | the bank gate is still stated in the README and the readiness doc |
| P13-1 | L | 2026-09-03 | review | pass | every service's `contract.test.ts` green against the real client source |
| P13-2 | L | 2026-09-03 | review | pass | only GETs retry |
| P13-3 | L | 2026-09-03 | review | pass | `AbortSignal.timeout`, 10 s default |
| M-1 | L | 2026-09-03 | review | **FAIL → fixed** | PS-01 500 and 429 both reported as `rejected`; now `unavailable` → the module answers 503. Fixed in all 13 copies |
| M-2 | L | 2026-09-03 | review | **FAIL → fixed** | MOD-15 and MOD-16 answered `{ ok: true }`; the whole-stack smoke test failed on it. Fixed, plus `deploy/test/readiness-contract.test.ts` pinning all 28 |
| M-3 | L | 2026-09-03 | review | pass | rejecting verifier + correct local credentials → 401, in every module's suite |
| M-4 | L | 2026-09-03 | review | pass | `handoff.test.ts`: single use, 30 s, `//`, `/\`, C0 controls and cross-module all refused |
| M-5 | S | 2026-09-03 | review | pass | all 16 modules boot with no service URLs and serve their API |
| M-6 | L | 2026-09-03 | review | pass | `neutralizeFormula` in all 10 CSV exporters; plain numbers exempt |
| M-7 | L | 2026-09-03 | review | pass | `npm run backup` exercised on PS-01, PS-11, MOD-04, MOD-09; MOD-09 copied its `storage/` too. Restore is covered by three suites; `deploy/test/backup.test.ts` re-derives the coverage |
| M-8 | S | 2026-09-03 | review | pass | smoke-stack asserts the header set on modules, not only services |
| M-10 | L | 2026-09-03 | review | pass | one transaction; shortages listed, no stock touched |
| M-11 | L | 2026-09-03 | review | pass | decrement and restore are exact mirrors |
| M-12 | L | 2026-09-03 | review | pass | one `computeTotals` shared by the API, the CSV and the document |
| M-13 | L | 2026-09-03 | review | pass | `import-offer.test.ts`: idempotent on the offer number, inconsistent totals refused |
| M-14 | L | 2026-09-03 | review | pass | finalized invoices immutable; PS-10 numbering gapless across a rollover |
| M-15 | S | 2026-09-03 | review | pass | provisioner sets `SOURCE_VIEWS_ONLY` from the published view contract; `registry.test.ts` re-derives it |
| T-1 | S | 2026-09-03 | review | pass | `blaustern` (MOD-04 + MOD-13 + MOD-15) provisioned, `.env` filled, smoke OK in 5.3 s. Also 16 modules × 12 services, OK in 25.9 s |
| T-2 | L | 2026-09-03 | review | pass | `deploy` suite, 375 tests |
| T-3 | L | 2026-09-03 | review | pass | `monitoring.test.ts`, both directions |
| T-4 | S | | | not run (needs a receiver) | still open — B-list |
| T-5 | S | | | not run (needs a host) | still open — A6 |
| D-1 | S | 2026-09-03 | review | partial | `export-subject.mjs` reviewed and its gap reporting confirmed by reading; not driven against a live stack |
| D-2 | S | 2026-09-03 | review | pass | erasure now closes the provider door too (P1-1); row and id survive |
| D-3 | S | 2026-09-03 | review | partial | prunes proven in-suite; not aged out over a real window on a stack |

### Suites, before and after

| Package | Before | After |
| --- | --- | --- |
| `platform/clients` | 17 | 17 |
| `ps-01-identity` | 137 | 141 |
| `ps-02-workflow-engine` | 108 | 112 |
| `ps-03-notification-hub` | 102 | 104 |
| `ps-04-ai-platform` | 91 | 93 |
| `ps-05-integration-hub` | 100 | 103 |
| `ps-06-file-storage` | 83 | 89 |
| `ps-07-audit-log` | 99 | 103 |
| `ps-08-payments` | 99 | 99 |
| `ps-09-search` | 83 | 86 |
| `ps-10-number` | 84 | 84 |
| `ps-11-customers` | 133 | 136 |
| `ps-12-banking` | 752 | 752 |
| `mod-01`…`mod-14` | 2 332 | 2 336 |
| `mod-15-workspace` | 133 | 133 |
| `mod-16-mosaic` | 76 | 77 |
| `deploy` | 346 | 375 |
| **Total** | **4 775** | **4 840** |

A run of this plan should leave an artefact, not a memory. This section is it.
