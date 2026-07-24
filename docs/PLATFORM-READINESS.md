# Platform Readiness Review

*Is the 0815software platform finished and ready for customer rollout?*
*Assessment after building PS-01…10, the shared clients package, and wiring all
14 modules. July 2026.*

## Verdict

**Not yet — but the foundation is done and coherent.**

What exists today is a strong, fully-tested **v1 platform skeleton**: ten
self-contained services (identity, workflow, notifications, AI, integrations,
files, audit, payments, search, numbering), a shared typed client package, and
all fourteen business modules wired to consume the platform. Every package's
test suite is green and runs **fully offline** (~552 tests across 25 packages,
no network, no vendor keys).

But "runs offline with mock adapters and dev secrets" is exactly the gap
between a **reference implementation** and a **customer-ready product**. The
platform is ready to *demo, evaluate, and build on*. It is **not ready to run a
paying customer's data on** until the blocking items below are closed. None of
them are architectural rewrites — they are the productionisation work that a
mock-first v1 deliberately defers.

This document is the punch-list to get from here to "finished, ready for
customer rollout," ordered by what blocks a launch.

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

### A5. Real vendor adapters have never run against real vendors
Every "real adapter when configured" path — Stripe (PS-08), Twilio/Slack/Teams/
Discord (PS-03), OpenAI images/speech/embeddings and the five chat vendors
(PS-04), Resend (PS-03), the OAuth providers (PS-01/PS-05), any S3 backend
(PS-06) — is a single-`fetch` adapter **exercised only against mocks in CI**.
They encode the happy path; none have met a real API's auth quirks, error
shapes, pagination, rate limits, or webhook-signature formats.
**Do:** live integration-test each adapter behind a flag; add provider-specific
retry/error handling; verify real webhook signatures against real payloads
(Stripe/GitHub/Shopify especially).

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

### B4. Contract stability & versioning
No API versioning (`/v1`), no OpenAPI specs, and client↔service contracts are
only covered by injected-fetch unit tests — not by tests that run the real
client against the real service.
**Do:** version the APIs, publish OpenAPI, add end-to-end contract tests that
boot a service and drive it with the real client.

### B5. Idempotency/retry consistency — ✅ MOSTLY CLOSED
PS-07 `POST /api/events` now accepts an optional `idempotency_key` (unique
index, migration 002; replay returns the original event with 200) — every
write-heavy service (PS-02/03/04/07/08) now has idempotency keys, and PS-09's
index is an upsert by design. Remaining: a shared outbound `retryFetch` for
the real vendor adapters (planned with the vendor-realism work).

---

## C. Product completeness (high-value opportunities)

The platform is wired, but most integrations are **shallow and one-directional**.

### C1. The flagship promise — one login across modules — is unrealised
Every module still ships its **own** authentication. No module actually
delegates login to PS-01 yet. This is the single highest-value remaining
integration (SSO across the suite) and the reason PS-01 exists.
**Do:** wire the modules' auth to PS-01 (session issuance + `tokens/verify`),
starting with the admin-login modules (they already share the HMAC idiom).

### C2. Integrations are mostly "emit an audit event"
Ten of fourteen modules only record audit events. Deeper value is unrealised:
driving module state machines through PS-02, reconciling PS-08 settlements back
into module ledgers, indexing *all* searchable entities into PS-09 (only mod-09
does today), and consuming PS-04 beyond mod-12's suggest-reply.
**Do:** deepen the integrations module by module where the ROI is clear.

### C3. No UI surfaces the new capabilities
Every integration is server-side. No module frontend yet exposes a PS-09 search
box, a PS-08 pay button, or PS-04 assistance.
**Do:** surface the capabilities in the module UIs.

### C4. Remaining new-service opportunities
- **PS-11 Feature Flags / Config** — flagged earlier; small, genuinely
  cross-cutting.
- **Inbound Email/Bridge service** — mod-12 explicitly needs a real mailbox;
  today it accepts pre-parsed JSON. A shared inbound-email service (IMAP/
  provider webhooks → normalized events) would unblock support intake.
See `docs/PLATFORM-SERVICE-OPPORTUNITIES.md` for the ranked list.

---

## D. Compliance & governance (DACH customers)

### D1. GDPR data handling
No data-retention or erasure ("right to be forgotten") endpoints, no PII
inventory, and encryption-at-rest exists only for PS-05 credentials. The audit
log is append-only (good for integrity) but has **no retention/rotation
policy** — which itself can conflict with erasure obligations.
**Do:** data-retention policies per service, erasure/export endpoints, a PII
map, and encryption-at-rest where customer data lives.

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
