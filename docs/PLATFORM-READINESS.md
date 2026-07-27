# Platform Readiness Review

*Is the 0815software platform finished and ready for customer rollout?*
*Assessment after building PS-01…11, the shared clients package, and wiring all
14 modules. July 2026. Updated after the composability campaign — see
[what that closed](#what-the-composability-campaign-closed).*

## Verdict

**Customer-rollout-ready, pending the user's vendor keys and npm org.**

*Updated after the finish-line campaign (Phases 1–8).* The original punch-list
below has been worked through end to end; each item now carries its status
inline. Every package's test suite is green and runs **fully offline** (~620
tests across 26 packages), and `deploy/smoke.mjs` boots every service in
production mode with generated secrets, verifying health, readiness, metrics,
the cross-service `platform:admin` seam, and security headers.

**What's closed (in code):** production boot guards + in-code hardening
(A1/A4), scoped service credentials and `platform:admin` seam RBAC (A2/A3),
schema migrations + backups (A6), a per-customer reference deployment with
Caddy TLS, tickers, and a smoke test (A7 + TLS/secrets/tickers), observability
— structured logs, `/api/ready`, `/api/metrics`, domain gauges (B1/B2),
OpenAPI + real-client contract tests (B4), SSO login-exchange across the 11
admin modules (C1), the real Stripe-Signature scheme + `retryFetch` + gated
live suites (A5 scaffolding), and compliance basics — audit retention with
chain integrity, message retention, GDPR erasure, PII map (D1).

**What remains — and it is genuinely only these — needs the user, not the
repo:**
1. **Vendor keys.** Run `npm run test:live` per service with real
   Stripe/Resend/Twilio/OpenAI/Anthropic/OAuth keys to validate the adapters
   against production (A5's last mile).
2. **npm publish.** Create the `0815software` npm org, add `NPM_TOKEN`, push a
   `platform-clients-v*` tag so modules can move off `file:` links (B3).
3. **A host + domain** for the reference deployment (Caddy issues the certs).

Deferred by explicit decision (documented, not blocking a first rollout):
mod-01/07/09 domain-user SSO, deeper per-module integrations (C2/C3),
data-export endpoints and cross-service erasure orchestration, and e-invoicing
archival (D2).

The per-item punch-list below is retained as the audit trail, each entry
annotated with what shipped.

---

## What the composability campaign closed

*July 2026, after the finish-line campaign.* The gap it addressed was not a
missing feature but a missing **seam**: fourteen modules and ten services all
existed and were tested, and there was still no way to turn "this customer
licensed these three modules" into a running deployment. Four things changed.

### 1. One machine-readable catalogue — [`modules/registry.json`](../modules/registry.json)

Module facts lived in three hardcoded copies (the marketing catalogue,
`demo/serve.mjs`, the hosted demo hub) and none of them knew a module's port, its
service dependencies or its deployment constraints. The registry now declares all
of it for all 14 modules and all 11 services, and those three consumers derive
from it. **`deploy/test/registry.test.ts` re-derives every claim from each
package's own `server/config.ts`**, so the registry cannot quietly become a lie —
which is what makes everything below safe to generate. See
[`PROVISIONING.md`](./PROVISIONING.md).

### 2. Provisioning — `deploy/provision.mjs`

One command turns a module selection into a customer deployment: compose file,
freshly generated secrets, Caddy TLS with a subdomain per module, an operator
README and a `manifest.json`. It starts **only the services the selection
references** (a two-module stack is seven, not eleven), includes the ticker
sidecar only when something ticks, wires `IDENTITY_URL` only where SSO is
supported, and handles MOD-08's read-only source database. A production
`deploy/module.Dockerfile` was added — the demo one has tmpfs databases and demo
seeding, which is not a production path.

### 3. The base is verified, not asserted — `deploy/smoke-stack.mjs`

`deploy/smoke.mjs` proved the services come up. This proves a *customer's stack*
comes up: it boots exactly the manifest's services and modules, in production
mode, with generated secrets, and checks health and readiness, every wired URL,
SSO where the registry says so and its absence where it does not, security
headers, the boot guard's refusal of a default secret, and that the generated
`.env` has no placeholder left. It also boots each module a second time **with no
service URLs at all**, so the standalone guarantee is now a test rather than a
claim.

Two capabilities had to be added to the modules for that: all 14 now expose
`GET /api/ready` (distinct from `/api/health`, and what the generated compose
health-checks poll) and all 14 now carry the platform's `server/hardening.ts` —
security headers, default-deny CORS, per-IP rate limits — mounted on every real
boot and omitted in tests, exactly as the services do it.

### 4. Shared customer data — PS-11 Customers (closes part of C2)

`demo/scenario.mjs` narrated "bill the accepted quote" while the code created the
customer from scratch in MOD-04 and retyped the line items. There was no data path
from an accepted offer to an invoice, and MOD-04/MOD-13 each owned a separate
customer table. [`CUSTOMER-MASTER-DATA.md`](./CUSTOMER-MASTER-DATA.md) records the
decision; the outcome is
[**PS-11 Customers**](../platform/ps-11-customers), a Platform Service owning
party master data with deterministic matching, per-module references (the
migration path for the module-local tables), and the stack owner's own `self`
party as a home for the duplicated seller identity. MOD-04 and MOD-13 consume it
through a new `CustomersClient`, optionally as always.

On top of it, the quote-to-invoice hand-off: MOD-13 exposes an accepted offer in a
neutral, self-checking transfer shape (`shared/transfer.ts`, copied into both
modules), and MOD-04 imports it into a draft invoice — idempotent on the offer
number, recording it on the invoice, refusing a transfer whose totals do not add
up. The demo now uses the real bridge, so the narrative and the code agree.

PS-11 was then finished to the purpose it was built for: `kind` gained `supplier`
(matching never crosses kinds), `POST /api/parties/:id/merge` reconciles duplicates
the service already holds while keeping the loser's id as a redirect, and the
`self` party is now the authority for the seller letterhead — MOD-04 and MOD-13
read it at boot and refresh it, with their `SELLER_*` env as a per-field fallback,
so renaming the company is one call rather than two `.env` edits and a redeploy.
Four modules share the party list: MOD-04, MOD-13, MOD-10 (companies) and MOD-06
(suppliers), each keeping its own row and storing the master `party_id`.

**What this did not close.** MOD-03 Inventory's supplier table is not migrated
yet, and MOD-01 Customer Portal is deliberately out — its `customers` are end
users with logins, an identity concern (item C1) rather than master data. Nothing
reports likely duplicates either: merging exists, finding candidates is still the
operator's eye. None of it blocks a rollout.

---

## A. Blocking for any customer production rollout

These must be closed before a customer's real data touches the platform.

### A1. Dev secrets everywhere; services boot on defaults
Every service ships and *boots* on well-known dev defaults —
`SESSION_SECRET=dev-secret-change-me`, `ADMIN_PASSWORD=change-me`,
`SERVICE_TOKEN=dev-service-token`, `WEBHOOK_SECRET=dev-webhook-secret`, PS-05's
all-zero `INTEGRATION_ENCRYPTION_KEY`. They warn but start.
**Do:** refuse to boot in `NODE_ENV=production` when any secret is a known
default; integrate a secret manager; document key rotation. (Small, high-value.)

### A2. Service-to-service auth is a single shared static token
The identity seam (`IDENTITY_URL` → PS-01 `tokens/verify`) is **optional and
off by default**. In the default posture, all inter-service and module→service
calls authenticate with one shared `SERVICE_TOKEN` per service — no per-caller
identity, no scopes, no rotation, no revocation.
**Do:** make PS-01-issued, scoped service credentials (or mTLS) the standard
for machine calls; enable the identity seam by default in deployed
environments; add token rotation/revocation.

### A3. Services have a single hardcoded admin; no RBAC of their own
PS-02…10 each authenticate exactly one operator (`ADMIN_USERNAME`/`PASSWORD`).
PS-01 has real users/roles/permissions, but the other services do not delegate
to it and have no multi-user or role model, and no audit of *their own* admin
actions.
**Do:** delegate service admin auth to PS-01 (roles/permissions), or at minimum
support multiple operators + per-action authorization.

### A4. No transport/deployment hardening
No TLS story, **no rate limiting on any service**, no CORS policy, no security
headers, `COOKIE_SECURE` defaults false, body-size limits only. The marketing
site's own analysis (`docs/ANALYSIS.md`) already flags rate-limiting as
best-effort — the services have none.
**Do:** TLS termination, per-IP/per-token rate limits, CORS allowlists, security
headers, `Secure` cookies behind HTTPS, request-timeout/DoS guards.

### A5. Real vendor adapters have never run against real vendors — ⏳ SCAFFOLDED
The realism gap is now closed in code, leaving only the user-supplied keys:
- **Real webhook signatures.** PS-08 verifies Stripe's actual
  `Stripe-Signature: t=…,v1=…` scheme (HMAC over `${t}.${body}` with a
  timestamp-tolerance replay guard), fixture-tested offline; the generic HMAC
  stays for the mock provider. PS-05 already verified real provider signatures.
- **Provider-specific retry.** A copy-in `retry-fetch.ts` (`withRetry`) wraps
  the production default fetch in PS-03/04/05/08 — retries 429/5xx with
  exponential backoff, honoring a numeric `Retry-After` — and is unit-tested
  deterministically. Injected test fetches are never wrapped, so unit tests
  stay exact.
- **Gated live suites.** `test/live/*` per adapter (Stripe, Resend, Twilio,
  OpenAI, Anthropic, GitHub) are excluded from the default `vitest run` and run
  via `npm run test:live`; each skips unless its `LIVE_*` key env is set.
**Remaining (user action):** supply the vendor keys and run `test:live` to
validate against production — the one step that cannot be done from the repo.

### A6. Persistence is single-file SQLite with no migrations, backups, or HA
Each service is one SQLite file. Schema evolution is `CREATE TABLE IF NOT
EXISTS` plus a couple of hand-guarded `ALTER TABLE`s — there is **no migration
framework**, no backup/restore, no replication. SQLite is single-writer, so the
tick-driven queues (PS-02/03/05/08) and the gapless counters (PS-10) are
correct on one instance but do not scale horizontally.
**Do:** adopt a migration tool; automate backup/restore; decide the scale story
(Postgres, or SQLite + streaming replication) before multi-instance.

### A7. Multi-tenancy is inconsistent across services
PS-01 is strictly multi-tenant; PS-09 has a `tenant` column. **PS-02, 03, 04,
05, 06, 07, 08, 10 are effectively single-tenant** — audit events, payments,
files, workflow instances, etc. are not isolated per tenant. For a SaaS
rollout that is a data-isolation defect.
**Do:** thread a tenant/org scope (from the PS-01 principal) through every
service's data model and queries, with tests that prove cross-tenant reads 404.

---

## B. Operational readiness (before scale / SLA)

### B1. No observability — ✅ CLOSED
Every service now ships a copy-in `server/telemetry.ts`: structured JSON
request logs with `X-Request-Id` propagation, `GET /api/ready` (DB reachable +
migrations current, distinct from `/api/health` liveness), and `GET
/api/metrics` in Prometheus text format — `http_requests_total{path,status}`
plus domain gauges: dead-letters (PS-02 `workflow_dead_deliveries`, PS-03
`notification_dead_messages`), stuck intents (PS-08
`payments_processing_intents`), pending sync jobs (PS-05), and PS-07's
`audit_chain_valid` (chain verified on a cached one-minute interval — chain
breaks now surface automatically). Remaining (deliberate): no distributed
tracing, and alert *rules* live in the customer's Prometheus, not in-repo.

### B2. Tick-driven work needs a reliable driver — ✅ CLOSED
All four tick-driven services (PS-02/03/05/08) now support the optional
in-process `TICK_INTERVAL_MS` timer, and the reference deployment
(`deploy/docker-compose.yml`) additionally runs a ticker sidecar POSTing
`/api/tick` each minute — belt and suspenders. Queue-depth gauges on
`/api/metrics` (B1) make a stopped ticker visible.

### B3. The clients package isn't actually published
The `publish-platform-clients` GitHub Action exists and dry-runs cleanly, but
`NPM_TOKEN` + the npm org aren't set, so the package is consumed only via local
`file:` links.
**Do:** create the npm org, add the secret, cut the first `platform-clients-v*`
tag; switch modules to the published semver for real independent deploys.

### B4. Contract stability & versioning — ✅ MOSTLY CLOSED
Every service now ships an `openapi.yaml` (OpenAPI 3.1) documenting its full
endpoint + auth surface, and a `test/contract.test.ts` that boots the real
service on an ephemeral port and drives the real `@0815software/platform-clients`
source over HTTP. Standing this up caught and fixed genuine client↔service
drift (workflow/notification/AI/integration return envelopes and field names)
that the injected-fetch unit tests could not see. Remaining (deliberate): no
`/v1` URL prefix — breaking and low-value pre-launch; the OpenAPI files plus
contract tests freeze the contract instead, and a prefix can be added at the
first breaking change.

### B5. Idempotency/retry consistency — ✅ MOSTLY CLOSED
PS-07 `POST /api/events` now accepts an optional `idempotency_key` (unique
index, migration 002; replay returns the original event with 200) — every
write-heavy service (PS-02/03/04/07/08) now has idempotency keys, and PS-09's
index is an upsert by design. Remaining: a shared outbound `retryFetch` for
the real vendor adapters (planned with the vendor-realism work).

---

## C. Product completeness (high-value opportunities)

The platform is wired, but most integrations are **shallow and one-directional**.

### C1. The flagship promise — one login across modules — ✅ MOSTLY CLOSED
The 11 shared-admin-idiom modules (mod-02…06, 08, 10…14) now delegate login to
PS-01 through a copy-in `server/sso.ts`: when `IDENTITY_URL` + `IDENTITY_ORG`
are set, PS-01 validates the credentials and must grant `platform:admin`
(configurable), and the module then issues its own local session exactly as
before — the request path is unchanged. When unset, each module falls back to
its local admin credentials, so standalone operation is intact. Verified per
module (injected verifier: PS-01 decides, local bypassed; rejects on fail;
local fallback when unconfigured) plus an end-to-end test booting a real PS-01
in-process. Deliberately deferred (documented): the domain-user modules with
their own identity models — mod-01 portal customers, mod-07 storefront guests,
mod-09 matter users — keep local auth for now; PS-01 gains org-scoped end-user
auth before they migrate.

### C2. Integrations are mostly "emit an audit event" — ⏳ PARTIALLY CLOSED
*The composability campaign closed the highest-value case: MOD-13 → MOD-04 is now
a real data path (an accepted offer becomes a draft invoice in one action), and
MOD-04/MOD-13 share one customer record through PS-11 Customers rather than
keeping private copies. The rest of the list below stands.*

Ten of fourteen modules only record audit events. Deeper value is unrealised:
driving module state machines through PS-02, reconciling PS-08 settlements back
into module ledgers, indexing *all* searchable entities into PS-09 (only mod-09
does today), and consuming PS-04 beyond mod-12's suggest-reply.
**Do:** deepen the integrations module by module where the ROI is clear.

### C3. No UI surfaces the new capabilities — ⏳ FIRST ONE SHIPPED
MOD-04's invoice list now has an **IMPORT OFFER** action that bills an accepted
quote end to end, which is the first platform capability with a button on it.
Otherwise unchanged: no module frontend yet exposes a PS-09 search box, a PS-08
pay button, or PS-04 assistance.
**Do:** surface the remaining capabilities in the module UIs.

### C4. Remaining new-service opportunities
*PS-11 is now taken by **Customers** (party master data), built during the
composability campaign — see [`CUSTOMER-MASTER-DATA.md`](./CUSTOMER-MASTER-DATA.md).
The next new service would be PS-12.*
- **Feature Flags / Config** — flagged earlier; small, genuinely
  cross-cutting.
- **Inbound Email/Bridge service** — mod-12 explicitly needs a real mailbox;
  today it accepts pre-parsed JSON. A shared inbound-email service (IMAP/
  provider webhooks → normalized events) would unblock support intake.
See `docs/PLATFORM-SERVICE-OPPORTUNITIES.md` for the ranked list.

---

## D. Compliance & governance (DACH customers)

### D1. GDPR data handling — ✅ MOSTLY CLOSED
- **Erasure.** PS-01 `POST /api/users/:id/erase` anonymizes a user's PII in
  place (email/name), scrambles the password, bumps `token_version` to kill
  live sessions, disables the account, and records a `user_erased` audit
  event — keeping the row+id for referential integrity.
- **Retention with integrity.** PS-07 `POST /api/rotate` + `RETENTION_DAYS`
  prune audit events older than the window while advancing the hash-chain
  anchor, so `/api/verify` still validates over the survivors. PS-03
  `RETENTION_DAYS` prunes terminal (sent/dead) messages on tick — their bodies
  carry recipient PII.
- **PII inventory.** [`docs/PII-MAP.md`](./PII-MAP.md) maps where personal data
  lives per service/module and the retention/erasure lever for each.
- Encryption-at-rest still covers PS-05 credentials specifically; full
  disk/volume encryption is a deployment concern (per-customer stack).
**Remaining:** export ("data portability") endpoints and automated
cross-service erasure orchestration — today erasure is operator/module-driven,
guided by the PII map.

### D2. Invoice/legal specifics
PS-10 delivers gapless numbering (a real DACH requirement — good). Still open:
e-invoicing formats (ZUGFeRD/XRechnung), immutable long-term invoice archival,
and tamper-evidence for the invoices themselves (PS-07 covers events, not the
documents).

---

## Suggested path to "finished, ready for customer rollout"

1. **Security baseline (A1–A4):** no-default-secrets boot guard, PS-01-backed
   service auth + identity seam on by default, delegate service admin to PS-01,
   rate limiting + TLS + secure cookies. *This is the gate to any pilot.*
2. **Data foundation (A6–A7):** migrations + backups; thread tenant isolation
   through every service.
3. **One real vendor per capability (A5):** prove Stripe (PS-08), Resend/Twilio
   (PS-03), one OAuth provider (PS-01), against live APIs behind flags.
4. **Operability (B1–B2):** logging/metrics/alerts + supervised tickers.
5. **Publish the client (B3)** and add contract/versioning (B4).
6. **The SSO integration (C1):** modules authenticate via PS-01 — the promise
   that makes this a *platform* rather than ten services next to fourteen apps.
7. **Compliance (D1–D2):** retention/erasure and invoice archival before DACH
   go-live.

**Bottom line:** the hard architectural work — a coherent, tested, offline-first
service catalog with a clean client and every module wired in — is **done**.
What remains is productionisation: secrets, real auth, tenancy, live vendors,
operability, and compliance. That is a well-scoped, non-speculative roadmap, not
open-ended research. Until items in section **A** are closed, treat the platform
as **evaluation-ready, not customer-ready**.
