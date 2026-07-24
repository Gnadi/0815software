# Platform Service Opportunities

*Candidate new Platform Services beyond PS-01…07, with a recommendation and
build plan for each. Written July 2026, after the platform-services
finalization.*

## Context

The catalog now has seven services (identity, workflow, notifications, AI,
integrations, file storage, audit) and a shared `@0815software/platform-clients`
package that the modules consume. During finalization, a systematic
module→service mapping surfaced a handful of cross-cutting concerns that **no
current service owns** and that more than one module re-implements or defers.
This doc ranks those opportunities, says which are worth a dedicated service
(versus a feature of an existing one), and sketches an in-ethos build for the
recommended ones so they can be picked up like any other PS-0x package.

Every proposal follows the established platform idiom: a standalone Express 5 +
better-sqlite3 backend, Node built-in crypto only, **deterministic mock/offline
by default with optional real adapters behind config**, Vitest/Supertest tests,
the `IDENTITY_URL` seam, and a client added to `platform/clients`.

## Ranking (recommendation)

| Rank | Candidate | Verdict | Why |
| ---- | --------- | ------- | --- |
| 1 | **PS-08 Payments** | **Build** | Money handling is a distinct domain (intents, refunds, reconciliation, PSP webhooks) that 3+ modules need and that is unsafe to leave as a thin proxy. |
| 2 | **PS-09 Search** | **Build if** modules need cross-entity/faceted search | Keyword + faceted search over many entity types; complements PS-04 RAG (semantic) rather than duplicating it. Lower urgency. |
| — | Feature Flags / Config | Fold into a small service later | Genuinely cross-cutting but tiny; can wait or ship as a lightweight PS-10. |
| — | Scheduling / Reminders | **Don't build** | Covered by PS-02 (schedules/triggers) + PS-03 (delivery). A new service would overlap both. |
| — | Reporting / Analytics | **Don't build** | MOD-08 Reporting Suite is a whole module; a service would duplicate it. Feed it from PS-02/PS-07 instead. |
| — | Localization / i18n | **Don't build now** | Belongs to the marketing site's i18n refactor (see `docs/ANALYSIS.md`), not the module platform. |

---

## PS-08 · Payments (recommended, port 4008)

**Purpose.** One place to take and reconcile money: create payment
intents/checkout sessions, capture/refund, and reconcile PSP webhooks to a
local ledger — so a module never touches card data or a PSP SDK directly.

**Why a dedicated service, not just a PS-05 Stripe connector.** PS-05 can
*call* Stripe, but payments carry domain concerns a generic proxy shouldn't:
strict idempotency on money operations, a double-entry-ish ledger, refund and
partial-capture state machines, a reconciliation view (PSP event ↔ local
intent), and a clear PCI boundary (modules hold references, never PANs). That
is a service, not an adapter. PS-08 *uses* PS-05 for the outbound PSP calls or
embeds its own single-`fetch` adapter — an open decision below.

**Consumers.** MOD-07 Storefront (checkout — "no payment SDK" today,
`mod-07/README.md`), MOD-04 Invoice & Billing (pay-an-invoice, reconciliation
— all out of scope today), MOD-14 Subsidies & Funds (disbursements), MOD-13
Offers (deposit on acceptance).

**Shape.**
- **Providers**: a deterministic **mock PSP** by default (offline: intents
  succeed/settle on `tick`), with optional real adapters (Stripe first) behind
  config — mirroring PS-04's provider pattern.
- **Payment intents**: `{amount, currency, reference, idempotency_key}` →
  `requires_payment | processing | succeeded | refunded | failed`, folded from
  an append-only event stream (PS-02 idiom) so status never drifts.
- **Refunds**: full/partial against a succeeded intent, with their own events.
- **Ledger**: append-only credits/debits per intent; a reconciliation endpoint
  matches inbound PSP webhook events to intents and flags orphans.
- **Inbound webhooks**: `POST /api/webhooks/:provider`, HMAC-verified (reuse
  PS-05's `verifySignature` scheme), recorded with a `signature_valid` verdict.
- **Endpoints** (sketch): `POST /api/intents`, `POST /api/intents/:id/capture`,
  `POST /api/intents/:id/refund`, `GET /api/intents/:id`, `POST /api/tick`
  (settle mock intents + retry webhook processing), `GET /api/ledger`,
  `POST /api/webhooks/:provider`. Service-token + identity seam.
- **Client**: `PaymentsClient` in `platform/clients`.

**In-ethos build notes.** Amounts are integer minor units (match MOD-04's
cents). Every money mutation takes an `idempotency_key` (PS-02/PS-04 dedupe
idiom). No card data is ever stored — only PSP references, encrypted at rest
if secret (reuse PS-05's AES-256-GCM helper). Fully offline and deterministic
under the mock PSP.

**Effort.** Medium–large (money state machines + reconciliation + tests). The
biggest of the candidates, and the highest value.

**Open decision.** Outbound PSP calls: (a) PS-08 embeds its own single-`fetch`
Stripe adapter (simplest, self-contained), or (b) PS-08 calls PS-05 as its
integration layer (DRY, but couples two services). Recommendation: **(a)** for
v1 — keep PS-08 self-contained like every other service; revisit (b) only if a
second PSP with existing PS-05 config appears.

---

## PS-09 · Search (build if needed, port 4009)

**Purpose.** Cross-entity keyword + faceted search: modules index their
records (id, type, title, body, facets) and query with filters, so search is
consistent and not re-hand-rolled per module.

**Why it complements PS-04, not duplicates it.** PS-04 RAG does *semantic*
(vector, cosine) retrieval for AI. PS-09 is *lexical* search — exact/keyword
matches, filters, facets, pagination — the "find the ticket / product /
document by words and attributes" case. Different job, different index.

**Consumers.** MOD-03 Inventory, MOD-09 Document Management, MOD-10 CRM Lite,
MOD-12 Support Tickets — each has its own local search today.

**Shape.**
- **Indexing**: `POST /api/index` with `{collection, id, type, title, body,
  facets, tenant}`; upsert by `(collection, id)`.
- **Search**: `GET /api/search?collection=&q=&facet.x=&limit=&offset=` →
  ranked hits + facet counts. Backed by SQLite **FTS5** (built in to
  better-sqlite3, zero extra deps) — deterministic, offline, no external
  search engine. Optional adapter (e.g. OpenSearch) behind config later.
- **Delete/reindex**, tenant scoping, `IDENTITY_URL` seam.
- **Client**: `SearchClient` in `platform/clients`.

**In-ethos build notes.** FTS5 keeps it self-contained and fast with no new
runtime dependency. Ranking via BM25 (FTS5 built-in). Deterministic tests over
a seeded corpus.

**Effort.** Small–medium. Only build once a module actually needs cross-entity
or faceted search beyond its local `LIKE` queries — otherwise it's premature.

---

## Also considered (not recommended now)

- **Feature Flags / Config (possible PS-10).** A tiny service for runtime
  flags + typed config per tenant/env. Real cross-cutting value but very small
  surface; ship it only when a module needs runtime toggles. Watch for scope
  creep into "remote config as a database."
- **Scheduling / Reminders.** Rejected: PS-02 already does interval schedules
  and triggers, and PS-03 does delivery. A reminders service would straddle
  both. Build reminders as a PS-02 workflow + PS-03 send instead.
- **Reporting / Analytics.** Rejected: MOD-08 Reporting Suite is a full module;
  a service would duplicate it. If shared metrics are needed, source them from
  PS-07 (audit events) and PS-02 (instance data), not a new service.
- **Localization / i18n.** Out of platform scope — this is the marketing
  site's build-time i18n refactor (`docs/ANALYSIS.md` §3), not a module
  concern.

## Suggested sequencing

1. **PS-08 Payments** — highest value, unblocks Storefront/Invoice payment
   flows. Build it next, self-contained with a mock PSP + optional Stripe.
2. Wire MOD-07 and MOD-04 to PS-08 (same opt-in, best-effort pattern as the
   MOD-04/MOD-12 reference integrations).
3. **PS-09 Search** — only when a module's local search is outgrown; FTS5 keeps
   it cheap when the need is real.
4. Revisit Feature Flags (PS-10) if runtime toggles become a recurring ask.

## Verification (per new service)

Same bar as the existing catalog: `npm test` green and fully offline; the
README quickstart `curl`s work against the mock provider; the `IDENTITY_URL`
seam accepts a PS-01 session when set and runs standalone when unset; a client
lands in `platform/clients` with an injected-fetch contract test; the service
is added to `platform/README.md`.
