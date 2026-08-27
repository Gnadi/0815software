# Test plan — PS-12 Banking and the MOD-04 changes

*Acceptance plan for branch `claude/ps-12-veu-distributed-signature`: 27
commits, ~83 non-vendored files, plus ~74 000 lines of vendored ISO 20022 and
EBICS schemas. August 2026.*

## Why this exists

The automated suites are large and they pass:

| Suite | Tests |
| --- | --- |
| `platform/ps-12-banking` | 752 |
| `modules/mod-04-invoice-billing` | 385 |
| `deploy` | 345 |
| `platform/clients` | 17 |

None of that makes the change ready. **No part of this code has ever spoken to
a real bank**, and the suites prove consistency with our own mock — which can
only encode our reading of the specification. The repository has already been
bitten by exactly that: `signOrderData` once hashed the order data and handed
the *digest* to a signer that hashes what it is given, so every payment was
signed over SHA-256(SHA-256(orderData)). The suite was green, and could not
have been otherwise: the mock verifies through the mirror of the broken
function, so client and counterparty agreed with each other and were wrong
together.

Four review rounds on this branch each found real defects — the last one a
status fold that would have released already-paid bills back into the pool for
a **second payment**. That is the record this plan is written against.

**The rule this document runs on:** an automated test proves we are consistent
with ourselves; a manual case establishes we are consistent with the bank, the
operator, or the money.

Read alongside:
- `platform/ps-12-banking/FIRST-CONNECTION.md` — the bank onboarding runbook.
  This plan does not repeat it; §13 says only what the runbook does not.
- `platform/ps-12-banking/README.md` §*Honesty about what is proven*.
- `docs/PLATFORM-READINESS.md` — the same verdict style, for the platform.

## Environments

Every case is tagged with the environment it needs.

| | Environment | How |
| --- | --- | --- |
| **L** | Local, against the in-repo mock bank | `npm ci && npm test` in the package, and the service run against `test/mock-bank.ts`. No credentials. |
| **S** | A provisioned stack | `node deploy/provision.mjs`, then `node deploy/smoke-stack.mjs --modules mod-04-invoice-billing --all-services`. Registry-driven, so PS-12 is included by selection. |
| **B** | A real EBICS test access at a bank | The blocking gate. Every **B** case is un-runnable until a bank exists. |

The tagging is the point: **every L and S case can be run today**, and the B
cases are visibly the ones that cannot. A green L column is not a release.

## How to read a case

> **F3 · The request that never came back** — **L**
> *Precondition:* a ready connection; the bank stubbed to time out.
> *Steps:* submit an order; when it fails, `GET /api/orders/{id}/exchanges`.
> *Expected:* one exchange with `error` set, `response_bytes` null, and the
> request body present and containing the signed envelope. Order status
> `failed`, not `rejected`.
> *If it differs:* **STOP** — an unanswered upload with no stored request is
> the case the log exists for.

Every case ends in **STOP** (blocks the release) or **NOTE** (record and
continue). A checklist without a stop rule gets completed rather than executed.

---

## 1 · Key lifecycle and custody

*Files:* `server/connections.ts`, `server/keystore.ts`, `server/ini-letter.ts`,
`server/key-change.ts`

*Already covered:* `lifecycle.test.ts` (36) walks created → keys_generated →
ini_sent → hia_sent → hpb_fetched → ready and refuses an order at every step
before `ready`. `x509.test.ts` (16) pins the hand-rolled certificates against
`node:crypto`'s own SPKI export. No endpoint returns a private key, asserted in
`api.test.ts`.

**A1 · The INI letter is a document a bank will accept** — **L**
*Steps:* bring a connection to `keys_generated`; `GET /api/connections/main/ini-letter.pdf`;
open it in a real PDF reader (not a browser preview).
*Expected:* it opens without repair prompts; hash values are grouped and
legible; Host/Partner/User ID and the three key digests are present and match
`GET /api/connections/main`.
*If it differs:* **STOP** — this sheet is signed and posted; a bank clerk
retypes it.

**A2 · The digests on paper equal the digests in the store** — **L**
*Steps:* compare each digest in the PDF, character by character, with
`subscriber_keys.digest`.
*If it differs:* **STOP.**

**A3 · Bank keys are not trusted until a human says so** — **L**
*Steps:* after HPB, attempt `POST /api/orders`; then verify with a *wrong*
digest; then with the right one.
*Expected:* 409 before verification; the wrong digest is refused and the
connection stays unverified; only the correct pair moves it to `ready`.
*If it differs:* **STOP** — this comparison is the entire defence against a
substituted key.

**A4 · A lock is one-way** — **L**
*Steps:* `POST /api/connections/main/lock`; then `/resume` and
`/clear-failure`.
*Expected:* state `locked`; both recovery routes refuse. The only way back is
new keys and a fresh INI letter.
*If it differs:* **NOTE.**

**A5 · Key change leaves no window without a usable key** — **B**
*Steps:* `POST /api/connections/main/key-change`; kill the service *between*
the request leaving and the response arriving (network drop).
*Expected:* the new keys are on disk as `pending`; the old keys still sign;
`/key-change/complete` or `DELETE` resolves it after establishing with the bank
whether it took.
*If it differs:* **STOP** — the failure mode is re-initialising on paper.

---

## 2 · Upload and orders

*Files:* `server/orders.ts`, `server/payload.ts`, `server/ebics/*`,
`server/bank-registry.ts`

*Already covered:* `orders.test.ts` (46) proves a file is submitted at most
once on two independent layers, that nothing is signed before every refusal has
had its chance (`bank.requests` stays empty), and that `rejected` and `failed`
stay apart. `schema.test.ts` (62) validates every built message against the
official H005 XSDs, envelopes **and** the deflated payloads inside `OrderData`.
`crypto.test.ts` (30) pins A005/AES/E002 against `openssl`.

**B1 · The bank accepts what the schema accepts** — **B**
*Steps:* submit one real pain.001 to the bank's file-check service, then over
EBICS.
*Expected:* both accept. If the schema is happy and the bank is not, the
difference is the thing to capture.
*If it differs:* **STOP**, and record the bank's exact complaint.

**B2 · Segmentation at the real limit** — **B**
*Steps:* submit a payload that crosses the bank's published segment limit.
*Expected:* `initialised` names the segment count; one `segment_sent` per
segment; `accepted`.
*If it differs:* **STOP** — set `segmentLimit` on the profile and repeat.

**B3 · Ceilings hold before signing** — **L**
*Steps:* set `max_amount_minor` below the file's total; submit.
*Expected:* 422 with a readable field error; **no** exchange recorded, because
nothing reached the network.
*If it differs:* **STOP** — at signature class E a signed order is money gone.

**B4 · A double-click is one payment** — **L/B**
*Steps:* submit the same run twice with the same idempotency key; then again
with the key omitted.
*Expected:* both return the original order; `replayed: true`; one order at the
bank.
*If it differs:* **STOP.**

**B5 · The BTF the bank actually wants** — **B**
*Steps:* compare `GET /api/connections/main/customer-data` (HTD) against the
profile in `bank-registry.ts` and against the contract.
*Expected:* the service/scope/msg-name triples match.
*If it differs:* **NOTE**, and correct the profile before B1.

**B6 · Verification of Payee** — **B**
*Steps:* submit with `vop` at `default`, then `opt-in`, then `opt-out`.
*Expected:* the bank's response reflects the choice; `default` sends no option.
*If it differs:* **NOTE.**

---

## 3 · Downloads and subscriptions

*Files:* `server/downloads.ts`, `server/subscriptions.ts`,
`server/bank-session.ts`, `server/customer-data.ts`, `server/veu.ts`,
`server/zip.ts`

*Already covered:* `downloads.test.ts` (32) proves the positive receipt goes
out only after the bytes are committed, that one unreachable bank does not stop
the others, and that a pass refuses to overlap itself — per database, not per
process. `customer-data.test.ts` (32) covers HTD/HKD/HPD/HAA. `zip.test.ts`
(12) covers the hand-rolled archive reader. `veu.test.ts` + `veu-parse.test.ts`
(36) cover the distributed-signature queue.

**C1 · A statement is never lost to a premature receipt** — **B**
*Steps:* during a BTD, kill the service *after* the segments arrive and
*before* the receipt.
*Expected:* on restart the bank re-offers the file; the digest index absorbs
the duplicate; nothing is lost.
*If it differs:* **STOP** — this loss is unrecoverable.

**C2 · Subscriptions poll what the contract allows** — **B**
*Steps:* seed subscriptions from HTD; run a tick.
*Expected:* every enabled subscription is polled once; each records
`last_fetched_at`; an unauthorised BTF reports a problem rather than throwing.
*If it differs:* **NOTE.**

**C3 · An unknown format is stored, not dropped** — **L**
*Steps:* have the mock offer a BTF nothing parses.
*Expected:* `kind: 'other'`, bytes downloadable from
`/api/downloads/{id}/content`, no exception.
*If it differs:* **STOP.**

**C4 · The VEU queue reflects reality** — **B**
*Steps:* submit with `request_eds`; read `/waiting`; co-sign from a second
subscriber; cancel a third order.
*Expected:* the queue matches the bank's own screen.
*If it differs:* **NOTE** — VEU is the least-exercised area against a real bank.

---

## 4 · Reading the bank's own data

*Files:* `server/camt.ts`, `server/statements.ts`, `server/hac.ts`,
`server/cim.ts`, `server/reports.ts`, `server/austrian.ts`

*Already covered:* `camt.test.ts` (53) reads camt.052/053/054 in `.02` and
`.08`, and pins the two findings that hurt: a collective credit must not be
attributed to one customer, and the Austrian-mandatory proprietary transaction
code must survive. `hac.test.ts` (29) reads the customer protocol, including
the official EBICS Working Group example files. `austrian.test.ts` (23)
validates against the STUZZA technical subset.

**D1 · A real camt.053 parses** — **B**
*Steps:* take the first real end-of-day statement; `GET /api/statements/{id}`.
*Expected:* balances, entry count and every entry match the bank's own PDF or
online-banking view, line for line.
*If it differs:* **STOP**, and keep the file as a fixture.

**D2 · Amounts are exact** — **B**
*Steps:* compare `amount` (text) and `amount_hundredths` for every entry.
*Expected:* the text is the bank's own string; the integer is exactly ×100;
null where the bank sent more than two decimals — never zero.
*If it differs:* **STOP** — a silently zeroed amount is the worst failure in
this document.

**D3 · Intraday does not double-count** — **B**
*Steps:* subscribe to camt.052 **and** camt.053; run a full day.
*Expected:* `findEntries` defaults to `source='statement'`; the same booking on
both messages appears once in the default view.
*If it differs:* **STOP.**

**D4 · A reversal is visible as a reversal** — **B**
*Expected:* `reversal = 1`, and MOD-04 refuses to match it.
*If it differs:* **STOP.**

**D5 · The customer protocol ties to the right order** — **B**
*Steps:* provoke a refusal; fetch HAC.
*Expected:* the entry keys on `ebics_order_id` and lands on the correct order,
never a stranger's.
*If it differs:* **STOP.**

**D6 · A collective credit is refused, not guessed** — **L/B** *(covered by a
test; re-run by hand once against real bank data)*
*Steps:* one entry carrying several customer payments → MOD-04 suggestions.
*Expected:* reason `collective`; per-transaction fields null; `batch_count`
set. No suggestion naming one customer.
*If it differs:* **STOP.**

---

## 5 · Status, and the money path

*Files:* `server/orders.ts` (`foldStatus`), `shared/types.ts`,
`modules/mod-04-invoice-billing/server/bills.ts`,
`modules/mod-04-invoice-billing/server/platform.ts`

*Already covered:* `orders.test.ts` covers the fold including `contested`;
MOD-04 `banking.test.ts` (32) covers submit, refresh, rejection releasing
bills, and a contested order releasing nothing.

**E1 · A settlement followed by a return releases nothing** — **L**
*Steps:* drive an order to `settled`; deliver a pain.002 RJCT for the same
MsgId; read the order and the MOD-04 run.
*Expected:* status `contested`. MOD-04 stores `bank_status: contested`, leaves
`payment_run_items.active = 1`, does **not** mark the run executed.
*If it differs:* **STOP** — releasing here is a second payment for an invoice
the bank already took the money for.

**E2 · The reverse order is equally contested** — **L**
*Steps:* HAC records a failure; a later status report says ACSC.
*Expected:* `contested`, terminal — a third answer does not resolve it.
*If it differs:* **STOP.**

**E3 · The ordinary paths are untouched** — **L**
*Expected:* `accepted → rejected` folds to `rejected` (the bank took the file
and then refused the payment — not a contradiction); `failed → settled` folds
to `settled` (`failed` means unknown).
*If it differs:* **STOP** — over-reporting `contested` makes the status
useless.

**E4 · A rejected run can be re-built, and gets a new MsgId** — **L**
*Expected:* bills released, a new run has a different `message_id`, and the
bank's duplicate check therefore accepts it.
*If it differs:* **NOTE.**

---

## 6 · Traceability

*Files:* `server/exchanges.ts`, `server/transport.ts`, `order_events`

*Already covered:* `traceability.test.ts` (15) — per-event timestamps, actor on
every event, every round-trip recorded with its bytes, the unanswered request
kept, no private key in any stored envelope, retention, and the admin-only
routes.

**F1 · A transfer can be reconstructed months later** — **B**
*Steps:* pick a completed payment. From `GET /api/orders/{id}` alone, answer:
when did each step happen, how long did the bank take, who caused it, what did
the bank say, and which file settled it.
*Expected:* all six answerable without opening the database.
*If it differs:* **STOP.**

**F2 · The envelope can be put in front of the bank** — **B**
*Steps:* `GET /api/orders/{id}/exchanges`, then `GET /api/exchanges/{id}`.
*Expected:* the request is the envelope as sent, byte for byte; the response is
the bank's answer verbatim.
*If it differs:* **STOP.**

**F3 · The request that never came back** — **L** *(see §How to read a case)*

**F4 · The log is not a credential store** — **L**
*Steps:* `grep` the whole `bank_exchanges` table for `PRIVATE KEY` and
`BEGIN RSA`.
*Expected:* nothing.
*If it differs:* **STOP.**

**F5 · Retention does not adopt somebody else's deletion** — **L**
*Steps:* delete one `bank_exchanges` row by hand; run a tick with nothing old
enough to prune.
*Expected:* the chain still reports `missing`, and `pruned_at` is set on
nothing.
*If it differs:* **STOP** — this was a real defect: the next tick used to wash
it green.

**F6 · Retention actually ages out** — **S**
*Steps:* set `EBICS_EXCHANGE_RETENTION_DAYS=1`; age a row; tick.
*Expected:* the row is gone, its link is marked pruned, the chain stays valid,
and `order_events` is untouched.
*If it differs:* **NOTE.**

---

## 7 · Audit chain

*Files:* `server/chain.ts`

*Already covered:* `chain.test.ts` (29) — every edit somebody covering their
tracks would make, and four cases in the other direction proving ordinary work
does not read as tampering. The verifier was mutation-tested: disabling the
content comparison fails four tests, dropping the head marker fails three.

**G1 · An edited event is caught** — **L**
*Steps:* `UPDATE order_events SET type='accepted' WHERE type='rejected'`; then
`GET /api/audit/chain`.
*Expected:* `valid: false`, `broken_kind: 'content'`, and the message names the
row.
*If it differs:* **STOP.**

**G2 · The cheap pass admits what it did not check** — **L**
*Steps:* the same edit, then `GET /api/audit/chain?quick=1` and `/api/metrics`.
*Expected:* `content_checked: false` and `valid: true` on the quick pass; the
gauge's help text says "cheap pass only".
*If it differs:* **STOP** — a green gauge that implies a full check is worse
than no gauge.

**G3 · The full pass is affordable at your volume** — **S**
*Steps:* time `GET /api/audit/chain` on a database of realistic size.
*Expected:* known and acceptable. Reference measurement: 20 000 exchanges
holding 2 GB of envelopes took **2.5 s** for the full pass and **0.2 s** for
the links.
*If it differs:* **NOTE**, and reconsider the retention window.

**G4 · The head leaves the container** — **S**
*Steps:* restart the service; find the `[ps-12] audit chain: … head …` line in
the collected logs; copy it somewhere the service cannot reach.
*Expected:* the head is in the log shipper, not only on the box.
*If it differs:* **STOP for production** — without an external anchor the chain
cannot survive a whole-database rewrite, and the README says so.

**G5 · The head survives a restart** — **L**
*Steps:* stop and start against a file database.
*Expected:* same head, same link count, chain valid.
*If it differs:* **STOP.**

---

## 8 · MOD-04 payables and the Austrian formats

*Files:* `shared/sepa.ts`, `shared/eact.ts`, `shared/finanzamt.ts`,
`server/austrian.ts` (PS-12 side)

*Already covered:* `sepa.test.ts` (52) is byte-stable golden output;
`sepa-schema.test.ts` (6) validates against the Austrian STUZZA pain.001;
`eact.test.ts` (14) and `finanzamt.test.ts` (7) cover structured remittance and
Finanzamt payments.

**H1 · A tax payment is accepted by the Finanzamt** — **B**
*Steps:* one real Finanzamtszahlung end to end.
*Expected:* accepted; the Ordnungsbegriff appears on the tax account.
*If it differs:* **STOP.**

**H2 · Structured remittance survives the round trip** — **B**
*Steps:* send an EACT-structured reference; read it back on the camt.
*Expected:* identical, unmangled.
*If it differs:* **NOTE.**

**H3 · The downloaded XML and the transmitted XML are the same bytes** — **L**
*Steps:* `GET /api/payment-runs/{id}/sepa.xml`; compare its SHA-256 with the
order's `payload_sha256`.
*Expected:* equal.
*If it differs:* **STOP** — the download is the fallback and the evidence.

---

## 9 · MOD-04 receivables

*Files:* `shared/matching.ts`, `server/receivables.ts`,
`src/components/IncomingPaymentsView.tsx`

*Already covered:* `matching.test.ts` (23) and `receivables.test.ts` (10) —
debits, reversals, already-applied, collective and unreadable amounts each
refused with a named reason.

**I1 · Standalone still works** — **L**
*Steps:* unset `BANKING_URL`; exercise the module.
*Expected:* behaves exactly as before this branch; the Incoming Payments view
degrades honestly rather than erroring.
*If it differs:* **STOP** — a module must not require a Platform Service.

**I2 · A suggestion is never applied twice** — **L**
*Steps:* apply the same booking twice, including a double-click.
*Expected:* the second is refused as `already_applied`.
*If it differs:* **STOP.**

**I3 · The view is usable with real volume** — **S**
*Steps:* load a real month of bookings.
*Expected:* the list renders and stays responsive; amounts and dates are
formatted for the locale.
*If it differs:* **NOTE.**

---

## 10 · Operations

*Files:* `server/index.ts`, `server/config.ts`, `server/db.ts`,
`scripts/backup.mjs`

*Already covered:* `config-env.test.ts` (30) covers every environment variable
including `EBICS_EXCHANGE_RETENTION_DAYS`; `upgrade.test.ts` (3) proves the
schema step is a no-op over a populated database; `source-hygiene.test.ts` (3)
refuses control characters in source; `openapi.test.ts` (4) keeps the spec and
the routes in step.

**J1 · A fresh install comes up clean** — **S**
*Expected:* one applied migration (`baseline`), 16 tables, `/api/ready` true,
chain valid with 0 links.
*If it differs:* **STOP.**

**J2 · A rotated key secret refuses to boot** — **L** *(verified 2026-08-23)*
*Steps:* generate keys under one `EBICS_KEY_SECRET`; restart with another.
*Expected:* the service refuses to start, with this message:
> `EBICS_KEY_SECRET does not decrypt the stored keys. It was probably rotated —
> a re-provision generates a fresh value for every secret. Restore the previous
> EBICS_KEY_SECRET; without it the bank connections must be re-initialised with
> the bank on paper.`
*If it differs:* **STOP** — `deploy/provision.mjs` mints a fresh value for
every declared secret on every provision, so this is reachable by accident.

**J3 · The runbook warns about that secret** — **S**
*Steps:* provision a stack including PS-12; read the generated runbook.
*Expected:* a named warning for `EBICS_KEY_SECRET`.
*If it differs:* **NOTE.**

**J4 · Backup, destroy, restore** — **L** *(verified 2026-08-23)*
*Steps:* `DATABASE_PATH=… BACKUP_DIR=… node scripts/backup.mjs`; delete the
database; put the snapshot in its place; start.
*Expected:* the key store opens, the chain verifies, the head is unchanged.
*If it differs:* **STOP.**

**J5 · The off-host copy exists** — **S**
*Expected:* `BACKUP_DIR` is copied off the host, and a restore has been
performed *from the off-host copy* at least once.
*If it differs:* **STOP for production** — an unexercised restore is a hope.

**J6 · Somebody is watching** — **S**
*Expected:* `/api/metrics` is scraped; `banking_chain_valid`,
`banking_orders_failed` and `banking_connections_ready` have alerts with owners.
*If it differs:* **STOP for production.**

**J7 · The tick actually runs** — **S**
*Steps:* leave the stack idle for three intervals.
*Expected:* downloads arrive; `TICK_INTERVAL_MS` or the stack ticker is doing
it. A stack where nobody ticks reconciles never.
*If it differs:* **STOP.**

**J8 · The egress guard refuses an internal bank URL** — **L**
*Steps:* configure a connection at `http://ps-01:4001`.
*Expected:* refused, and the refusal is recorded as an exchange.
*If it differs:* **STOP** — a "bank" inside the stack would be handed signed
payment files.

**J9 · An order route needs the right credential** — **L**
*Expected:* `X-Service-Token` may submit and read an order; it may **not** read
`/api/exchanges`, `/api/audit/*`, or any connection route (403). No credential
is 401.
*If it differs:* **STOP.**

> **On route coverage.** PS-12 registers 54 routes and MOD-04 ten banking
> routes; this plan does not give each one a manual case, and does not pretend
> to. `api.test.ts` (93) checks the credential line on **every** operator route
> twice — once for no credential and once for a valid service token — and
> `openapi.test.ts` (4) fails if a route exists without a spec entry or a spec
> entry without a route. The manual cases here cover the routes where a wrong
> answer costs money or evidence; the rest are covered by automation only, and
> that is the claim being made.

---

## 11 · Catalogue, clients and site

*Files:* `modules/registry.json`, `platform/clients/src/banking.ts`,
`src/data/platform.ts`, `src/i18n/translations.ts`, `platform/README.md`

*Already covered:* `deploy` (345) covers registry drift, provisioning and the
en/de copy-key guard; `platform/clients` (17) covers the per-service client
count.

**K1 · The landing page tells the truth** — **L**
*Steps:* `npm run build` at the root; read the PS-12 entry in both languages.
*Expected:* no claim the code does not support. Counts of order types and BTFs
are checked against the README, not from memory — this page has carried a wrong
count before.
*If it differs:* **STOP.**

**K2 · A second consumer needs three lines** — **L**
*Steps:* wire `BankingClient` into any other module in a scratch branch.
*Expected:* config, construct, `submitOrder` — no PS-12-specific knowledge
beyond a BTF.
*If it differs:* **NOTE.**

---

## 12 · Regression cases the review earned

Each of these was a real defect on this branch. Their regression tests fail
against the unfixed code — that was verified when each was fixed — but they are
listed here because they are the cases a reviewer should re-establish by hand
rather than trust.

| | What was wrong | Case |
| --- | --- | --- |
| 1 | A collective credit was attributed to one customer | D6 |
| 2 | Ticks could overlap | C (covered), J7 |
| 3 | Every step of a submission shared one timestamp | F1 |
| 4 | `order_events` had no actor | F1 |
| 5 | Nothing kept the bytes of a bank conversation | F2, F3 |
| 6 | Retention laundered a hand-deletion green | **F5** |
| 7 | The digest encoding was ambiguous (separator collision) | G1 |
| 8 | `chain.ts` held a NUL byte — unreviewable in a diff | automated only |
| 9 | Full chain verification ran on a timer | G2, G3 |
| 10 | A migration rebuild dropped later-added columns | J1 |
| 11 | The status fold silently picked a side | **E1**, E2, E3 |
| 12 | The tick guard was per-process | J7 |
| 13 | Nothing parsed `openapi.yaml` | automated only |

---

## 13 · The blocking gate: the first real bank

`platform/ps-12-banking/FIRST-CONNECTION.md` is the runbook — preconditions,
the step-by-step, the failures to expect, and how to recover. **Follow it; do
not duplicate it here.** This section adds only two things.

**Treat the first connection as a debugging exercise, not a rollout.** Budget
days, not an afternoon. Have the bank's own example messages and its file-check
service open before starting.

**Capture while you are in there** — this is the only chance:
- the exact BTFs the bank accepted, and what it called them on the phone;
- its segment limit, if not 1 MB;
- how long activation actually took;
- which codes it returns for the ordinary refusals;
- whether `HTD` matched the contract;
- one real camt.053, one real pain.002 and one real HAC, as fixtures.

**Acceptance for the first connection:** A1–A3 pass on paper, B1 accepted, D1
and D2 exact against the bank's own statement, D5 ties a real refusal to its
order, and F1/F2 answer for a real payment.

---

## 14 · Exit criteria

Production-ready means all of:

1. Every **L** and **S** case above passes, recorded in §15.
2. Every **B** case passes against a real bank test access.
3. A human other than the author has reviewed at least
   `server/keystore.ts`, `server/ebics/crypto.ts`, `server/ebics/dsig.ts`,
   `server/chain.ts`, `server/transport.ts` and `server/orders.ts`. At
   signature class E a signed order is money gone.
4. J5 (a restore from the off-host copy) and J6 (someone is paged) are done.
5. A pilot with `max_amount_minor` set low, for a period agreed in advance.

**Not covered by this plan, and deliberately:**
- `pain.008` SEPA direct debit — deferred; the schema is vendored, no mandate
  model exists.
- `H3K` — not built.
- Splitting a collective booking into its individual payments — refused by
  design today.
- German camt.052/054 profile entries — no published table row was found.
- Load and soak testing beyond the single `verifyChain` measurement in G3.
- Any bank-specific certification.

---

## 15 · Record sheet

**Run on 2026-08-24.** 30 cases executed, 6 partly, 17 still needing a bank.

The L cases are automated by `npm run acceptance` in `platform/ps-12-banking`
and `modules/mod-04-invoice-billing` — the harness drives the services' own
HTTP routes rather than re-running the unit suites, and prints PASS/FAIL with
the evidence quoted below. `S` cases go through `deploy/smoke-stack.mjs`.

**What this run found** (three things, none of them in the L cases):

1. **J6 — nothing watched PS-12.** The generated Prometheus scrapes `ps12:4012`
   and no alert rule named a single PS-12 gauge, so `banking_orders_failed`
   (each one a payment whose outcome is unknown) and `banking_chain_valid`
   arrived where nobody read them. Rules added to `deploy/provision.mjs`, plus
   the converse test that was missing: every service publishing domain gauges
   must have a rule, with informational gauges listed by name rather than
   pattern-matched away.
2. **A pre-existing repo defect, surfaced by running S.** `smoke-stack.mjs`
   matched the boot guard on "refusing to start in production with **default**
   secrets" while all 28 guards say "**unusable** secrets — still set to a
   shipped default". The check could never pass. Unrelated to this branch —
   `guard.ts` and `smoke-stack.mjs` are both untouched by it — and fixed here
   because leaving a permanently-failing check is worse than the one-line
   correction.
3. **K1 — a claim phrased as more than it is.** Both the README and the
   landing page said "every order type the H005 schema set defines but one".
   The schema set defines no such list: `OrderTBaseType` is a bare
   `[A-Z0-9]{3}` pattern. What it does define is a dedicated order-data
   structure for twelve order types, of which eleven are built. Corrected in
   the README and in both language blocks.

Four assertion mistakes were mine, not the code's, and are recorded because
they are what a first run costs: the HTTP surface returns the order directly
(a replay is 200, not a `replayed` field), the INI letter prints hex rather
than base64, `/api/receivables/apply` takes a batch whose refusals are
per-application, and the invoice route is `/finalize`, not `/issue`.

A run of this plan should leave an artefact, not a memory.

| Case | Env | Date | Who | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 | L | 2026-08-24 | acceptance run | pass | structurally valid PDF, 9067 bytes; naming Host/Partner/User. Opening it in a PDF reader is still outstanding |
| A2 | L | 2026-08-24 | acceptance run | pass | all 3 stored digests found on the letter as uppercase hex |
| A3 | L | 2026-08-24 | acceptance run | pass | order before verification 409; wrong digest 409; only the right pair reaches ready |
| A4 | L | 2026-08-24 | acceptance run | pass | lock 200 → locked; resume 409; clear-failure 409 |
| A5 | B | | | not run (needs a bank) | |
| B1 | B | | | not run (needs a bank) | |
| B2 | B | | | not run (needs a bank) | |
| B3 | L | 2026-08-24 | acceptance run | pass | 422, exchanges unchanged, 0 orders — nothing reached the network |
| B4 | L/B | 2026-08-24 | acceptance run | pass | 201 then 200 then 200, one order; replay is the status code |
| B5 | B | | | not run (needs a bank) | |
| B6 | B | | | not run (needs a bank) | |
| C1 | B | | | not run (needs a bank) | |
| C2 | B | | | not run (needs a bank) | |
| C3 | L | 2026-08-24 | acceptance run | pass | kind "other", bytes recoverable from /content |
| C4 | B | | | not run (needs a bank) | |
| D1 | B | | | not run (needs a bank) | |
| D2 | B | | | not run (needs a bank) | |
| D3 | B | | | not run (needs a bank) | |
| D4 | B | | | not run (needs a bank) | |
| D5 | B | | | not run (needs a bank) | |
| D6 | L/B | 2026-08-24 | acceptance run | pass | collective refused as "collective"; the ordinary credit still proposed |
| E1 | L | 2026-08-24 | acceptance run | pass | bank_status contested, bill stays scheduled, run not executed |
| E2 | L | 2026-08-24 | acceptance run | pass | contested both ways round, and terminal |
| E3 | L | 2026-08-24 | acceptance run | pass | accepted→rejected stays rejected; failed→settled resolves |
| E4 | L | 2026-08-24 | acceptance run | pass | bill released, new run has a different MsgId |
| F1 | B | | | not run (needs a bank) | |
| F2 | B | | | not run (needs a bank) | |
| F3 | L | 2026-08-24 | acceptance run | pass | HTTP 201 status failed, 1 exchange, error kept, request present |
| F4 | L | 2026-08-24 | acceptance run | pass | 5 exchanges scanned, no PEM material |
| F5 | L | 2026-08-24 | acceptance run | pass | still "missing" after a tick that pruned 0 and marked 0 |
| F6 | S | 2026-08-24 | acceptance run | partial | stack booted; retention not aged out over a real window |
| G1 | L | 2026-08-24 | acceptance run | pass | content break, names order_events #1 |
| G2 | L | 2026-08-24 | acceptance run | pass | quick content_checked=false valid; full invalid; gauge says "cheap pass only" |
| G3 | S | 2026-08-24 | acceptance run | partial | reference measured (2.5 s / 0.2 s at 20 000); not re-measured at stack volume |
| G4 | S | 2026-08-24 | acceptance run | partial | the boot line prints the head; shipping it off-box is an operator step |
| G5 | L | 2026-08-24 | acceptance run | pass | 9 links, same head after stop/start on a file |
| H1 | B | | | not run (needs a bank) | |
| H2 | B | | | not run (needs a bank) | |
| H3 | L | 2026-08-24 | acceptance run | pass | sha256 equal on the transmitted and downloaded XML |
| I1 | L | 2026-08-24 | acceptance run | pass | submit 409, download 200, suggestions 501 naming the alternative |
| I2 | L | 2026-08-24 | acceptance run | pass | recorded then already_applied; 1 payment row; paid once |
| I3 | S | 2026-08-24 | acceptance run | partial | needs a browser and a real month of bookings |
| J1 | S | 2026-08-24 | acceptance run | pass | 1 migration (baseline), 16 tables, ready, chain valid |
| J2 | L | 2026-08-24 | acceptance run | pass | boot refused; message quoted verbatim in §10 |
| J3 | S | 2026-08-24 | acceptance run | pass | runbook carries the ⚠️ section and the --force warning |
| J4 | L | 2026-08-24 | acceptance run | pass | restore opened the key store, chain valid, head unchanged |
| J5 | S | 2026-08-24 | acceptance run | partial | off-host copy and restore-from-it are operator steps |
| J6 | S | 2026-08-24 | acceptance run | FIXED | was FAIL: PS-12 scraped but no rule watched its gauges. Rules added + converse test |
| J7 | S | 2026-08-24 | acceptance run | partial | stack lists PS-12 as tick-driven; not idled for three intervals |
| J8 | L | 2026-08-24 | acceptance run | pass | 422, recorded "refused by the egress policy: 127.0.0.1 is an internal address" |
| J9 | L | 2026-08-24 | acceptance run | pass | order read 200; service token 403 elsewhere; anonymous 401 |
| K1 | L | 2026-08-24 | acceptance run | NOTE | wording corrected: the H005 set does not enumerate order types |
| K2 | L | 2026-08-24 | acceptance run | pass | config + construct + submitOrder; token sent; 11 payload-agnostic methods |

**Totals:** 53 cases — 25 **L**, 9 **S**, 17 **B**, 2 runnable in both (**B4**,
**D6**). After the run of 2026-08-24: **30 executed, 6 partial, 17 waiting on a
bank.** The six partial ones need an operator or a browser rather than more
code — an off-host restore, a log shipper, a month of real bookings, three tick
intervals of patience.

**34 of the 53 can be run today**, before any bank exists. That number is the
honest measure of how much of this change can be accepted right now, and the
17 **B** cases are the honest measure of how much cannot.
