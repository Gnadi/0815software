# Platform Production-Readiness Roadmap

_How the 0815software platform gets from "architecturally complete" to
"production-grade", without redesigning the architecture or collapsing the
services into a monolith._

## Guiding principle

The goal is to be the **Laravel / Rails / Spring Boot of autonomous business
software**: one product to install, run, and reason about, that happens to be
service-oriented inside. That framing settles most trade-offs in this document
in favour of **consistency, maintainability, and developer experience** over
microservice purity. Concretely:

- Cross-cutting behaviour (logging, errors, health, hardening, persistence)
  should have **one implementation** the services share — not ten copies to
  keep in sync.
- The default developer path is **one command**, one machine, SQLite, no
  secrets to fill in.
- Services stay **independently deployable**, but the platform is packaged,
  documented, and operated as a single product.

## What is already solid (do not rebuild)

An honest baseline — a lot of "production readiness" is already present and
consistent across all ten services:

| Area | Status |
| --- | --- |
| Health / readiness | `GET /api/health` (liveness) + `GET /api/ready` (DB reachable + schema migrated) on every service |
| Metrics | `GET /api/metrics` in Prometheus text format, request counters + domain gauges (dead-letters, stuck intents, audit-chain validity) |
| Structured logging | One JSON line per request: `service`, `ts`, `request_id`, `method`, `path`, `status`, `duration_ms` |
| Correlation ids | `X-Request-Id` accepted from callers and echoed; generated when absent |
| Error contract | Shared `DomainError` → `{ error, details }` with a fixed status convention (422/409/404/401/403) |
| Transport hardening | Per-IP token-bucket rate limiting (stricter on login), security headers, default-deny CORS with env allowlist, HSTS, socket timeouts |
| Secret safety | Production boot guard refuses to start with known dev-default secrets |
| Persistence | SQLite with WAL, foreign keys, an append-only idempotent migration runner |
| Server-side idempotency | Present in payments, workflow, notifications (dedupe keys in schema) |
| Retry / backoff | Server-side webhook/delivery retry schedules with dead-lettering |
| Deployment | Production `docker-compose` (Caddy TLS, per-service volumes, healthchecks, ticker sidecar), shared Dockerfile, no-Docker smoke test |
| Security seam | Service tokens + PS-01 identity propagation + `platform:admin` permission checks, API-key scopes |

The work below is about the **gaps between** these good pieces — most
importantly the client call path, the duplicated per-service boilerplate, and
the contract/persistence seams.

---

## Delivered in this pass

Two of the Critical items are already implemented in this change:

1. **Client-side resilience (`platform/clients`).** The shared `BaseClient`
   now applies, to every service-to-service call: a per-request **timeout**
   (default 10 s), **retry with exponential backoff + jitter** on transient
   failures, a per-peer **circuit breaker**, **`X-Request-Id` propagation**,
   and opt-in **idempotency keys** (`Idempotency-Key`) that also make writes
   retry-safe. A new `ServiceUnavailableError` lets callers degrade gracefully
   instead of crashing when a peer is down. Fully backward compatible; unit
   tested (`test/resilience.test.ts`).
2. **One-command local development.** `deploy/docker-compose.dev.yml` +
   `make dev` bring the entire platform up locally with nothing to configure
   (ports 4001–4010, dev defaults), while each service remains independently
   runnable.

---

## Prioritized roadmap

Effort is rough: **S** ≈ hours, **M** ≈ 1–3 days, **L** ≈ a week+, per item,
and where an item is "×N services" that multiplier is called out.

### 🔴 Critical — correctness/safety gaps that bite in production

**C1. Extract the duplicated per-service runtime into one shared package.**
`telemetry.ts`, `hardening.ts`, `errors.ts`, `guard.ts`, and the migration
runner are **byte-identical across all ten services** (verified). A shared
`@0815software/platform-runtime` package (mirroring the existing
`platform/clients` package) would own them, and each service would call one
`bootstrapService({ name, port, gauges, migrations })` helper.
_Benefit:_ a fix or feature (e.g. adding trace context to logs) is written
once, not ten times; this is the backbone of the framework vision and unblocks
most other items below. _Effort:_ **M** to build the package, **S ×10** to
switch each service over. _Constraint respected:_ services stay independent —
they depend on a library, not on each other.

**C2. Honour the `Idempotency-Key` header end-to-end.** The client now sends
it, but services currently dedupe on a **body** `idempotency_key`. Make the
runtime (C1) read the header, fall back to the body field, and enforce dedupe
uniformly for payments, workflow, and notifications.
_Benefit:_ retried writes (which the new client will do) can never
double-charge, double-notify, or double-fan-out. _Effort:_ **S** in the shared
runtime + **S** per write endpoint.

**C3. Graceful degradation when a peer is offline, verified.** The client
change makes unreachable peers throw `ServiceUnavailableError` instead of
hanging; audit each **module's** call sites to catch it and fall back to
standalone behaviour (many already do this when a URL is unset). Add a test per
module that the app still serves when a platform service is down.
_Benefit:_ "never crash because another service is offline" becomes a tested
guarantee, not an aspiration. _Effort:_ **M** across modules.

### 🟠 High — needed before calling the contracts stable

**H1. Version the public APIs.** Routes are unversioned (`/api/...`). Introduce
a `/api/v1/` prefix (alias the old paths for one release for backwards
compatibility) so future breaking changes have somewhere to go.
_Benefit:_ lets the product evolve without breaking installed modules; a
prerequisite for "backwards compatibility wherever possible" to mean anything.
_Effort:_ **S ×10** (mount the router under both prefixes).

**H2. Single source of truth for DTOs.** Types are declared twice — each
service's `shared/types.ts` **and** `platform/clients/src/types.ts` (26
interfaces). Promote the wire DTOs into a shared `@0815software/platform-contracts`
package consumed by both sides.
_Benefit:_ removes drift between what a service returns and what its client
expects; kills a whole class of "works in the test, breaks over the wire" bugs.
_Effort:_ **M**.

**H3. Schema-driven request validation + generated OpenAPI.** Validation is
hand-rolled (`reqText`/`reqEmail`) — consistent but manual, and the
`openapi.yaml` files are hand-maintained and **not served or checked against
the implementation**. Adopt one small schema approach (e.g. a tiny internal
validator or a zero-dep-friendly library), validate every incoming payload
from the schema, generate OpenAPI from it, serve it at `/api/openapi.json`, and
**fail CI on drift**.
_Benefit:_ payloads are validated uniformly; docs can't rot; contracts become
machine-checkable. _Effort:_ **L** (design once in the runtime), **M ×10**.

**H4. Abstract persistence behind a repository seam.** `better-sqlite3` and its
**synchronous** API are used directly across ~8 business-logic files per
service. Introduce a thin repository/gateway interface so business logic never
sees `db.prepare(...)`; keep the SQLite implementation as default and make the
methods async-friendly so a PostgreSQL adapter can slot in later.
_Benefit:_ delivers goal #7 (SQLite default, Postgres later with minimal
effort) without leaking DB-specifics into domain code. _Effort:_ **L** —
sequence it **after C1** so the seam lives in the shared runtime.

### 🟡 Medium — hardening and scale-readiness

**M1. Per-service least-privilege tokens.** Today one shared `SERVICE_TOKEN`
authenticates all machine-to-machine calls. Issue **per-caller scoped tokens**
(PS-01 already has API keys with scopes) so a compromised module can't act as
every other one.
_Benefit:_ real least-privilege between services. _Effort:_ **M**.

**M2. Optional OpenTelemetry export.** Correlation ids already flow; add an
opt-in OTel/trace exporter in the shared runtime (off by default) so ids can
become spans in a real tracing backend.
_Benefit:_ end-to-end request tracing across services when operators want it,
zero cost when they don't. _Effort:_ **M**.

**M3. Identify and queue the operations that should be async.** Ticks already
drive queue/scheduler work; audit remaining **inline** outbound side-effects
(e.g. a synchronous notification send during a request) and move them behind
the queue so a slow downstream never slows a user request.
_Benefit:_ predictable request latency; fewer cascading timeouts. _Effort:_
**M**.

**M4. Rate-limit / breaker state note for multi-instance.** The token buckets
and circuit breaker are **per-process** — correct and sufficient for the
single-node-per-customer deployment model, but document it, and add a shared
store (e.g. Redis) only if/when a service is scaled horizontally.
_Benefit:_ avoids a surprise when someone runs two replicas. _Effort:_ **S**
to document, **M** to implement a shared store later.

**M5. Enforce the shared project structure.** Every service already follows the
same layout; add a lint/CI check (and the C1 runtime) so new services can't
drift, plus a scaffolding generator (see N3).
_Benefit:_ the "every service follows the same structure" guarantee becomes
mechanical. _Effort:_ **S**.

### 🟢 Nice to have — polish and velocity

**N1. Dev observability bundle.** Add an optional Prometheus + Grafana profile
to `docker-compose.dev.yml` so `make dev` can also show dashboards.
_Benefit:_ metrics are visible locally, not just scrapeable. _Effort:_ **S**.

**N2. Contract tests between clients and services.** With H2 in place, generate
tests that assert each client's expectations against each service's live
responses. _Benefit:_ catches contract drift automatically. _Effort:_ **M**.

**N3. `create-service` / `create-module` scaffolder.** A generator that emits a
new service pre-wired to the shared runtime (C1), contracts (H2), tests, and
Dockerfile — the Rails `new` moment. _Benefit:_ minutes to a new, consistent
service. _Effort:_ **M**.

**N4. PostgreSQL compose profile.** Once H4 lands, ship a `--profile postgres`
that swaps the adapter, proving the abstraction end-to-end. _Benefit:_ a
one-flag upgrade path for customers who outgrow SQLite. _Effort:_ **S** after
H4.

**N5. Shared config loader.** A small `config` helper in the runtime that reads
env with typed defaults and prints a **startup diagnostics banner** (resolved
ports, which downstream URLs are wired, which secrets are still defaults).
_Benefit:_ better "why won't it start / who is it talking to" answers.
_Effort:_ **S**.

---

## Suggested sequencing

```
C1 (shared runtime)  ──►  C2, H1, H3, H4, M1, M2, M5   (all ride on it)
      │
      └──►  C3 (module degradation)  and  H2 (contracts)  in parallel
```

Do **C1 first**: it is the highest-leverage change and the thing that makes the
platform feel like one framework rather than ten similar services. Almost every
other item is cheaper once the cross-cutting code lives in one place.

## Platform-integration notes (goal #9)

- **Duplication to fold into platform services:** audit modules for local
  re-implementations of numbering, notification, file handling, and audit —
  each has a platform service (PS-10/03/06/07) that should be the single
  implementation. Where a module still does it inline, migrate it to the client.
- **New shared capabilities — only if several modules need them.** Candidates
  seen across modules but _not yet_ justified as their own service: a shared
  **scheduling/cron** capability (several modules poll) and a shared
  **PDF/document-render** capability. Recommend building these as platform
  services **only** once two or more modules genuinely require them — otherwise
  they add distributed-system cost for no gain, against the simplicity
  constraint.

## Non-goals (explicitly out of scope)

- No Kubernetes assumptions — the deployment model is one stack per customer on
  a single host.
- No merging services into a monolith — independence is preserved; sharing is
  via libraries (runtime, contracts, clients), never by reaching into another
  service's internals or database.
- No premature distributed-systems machinery (service mesh, distributed
  transactions) — prefer the simple, single-node-friendly option until scale
  demands otherwise.
