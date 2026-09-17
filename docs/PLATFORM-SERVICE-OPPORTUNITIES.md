# Platform Service Opportunities

*Candidate new Platform Services beyond PS-01…07, with a recommendation and
build plan for each. Written July 2026, after the platform-services
finalization.*

> **September 2026.** Two entries were added after the original write-up: the
> reporting read-model split, and a verdict on turning PS-01 into an eIDAS
> identity-verification platform — *don't*, with three cheaper alternatives.
> See the ranking table and the entry near the end. The first of those three,
> enterprise SSO, has since been **built** — its write-up carries the one
> dependency decision this catalog has had to make.

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
| — | Reporting **presentation** | **Don't build** | MOD-08 Reporting Suite is a whole module; a service would duplicate it. |
| — | Reporting **read models** (a future service, no number reserved) | **Not yet** — a convention covers it | Modules publish `report_*` views in their own database (`docs/REPORTING-CONTRACT.md`). Zero runtime cost. Revisit on a *second* consumer or a need to report across hosts. |
| — | **PS-12 Banking** | **Built** | EBICS bank transport. Key custody is the argument: an EBICS subscriber holds RSA keys sufficient to move money, and in a module they end up in every module that ever needs a bank. Written up below. |
| — | Localization / i18n | **Don't build now** | Belongs to the marketing site's i18n refactor (see `docs/ANALYSIS.md`), not the module platform. |
| — | **Enterprise SSO in PS-01 (OIDC · SAML · SCIM)** | **Built** | The adoption blocker, done September 2026. One deliberate dependency for SAML — XML-DSig verification fails open, and this catalog's other XML-DSig code signs rather than verifies. Reasoning in the entry below. |
| — | **Identity verification / eIDAS platform in PS-01** | **Don't build** | Not software but regulatory status, licensed data and Art. 9 liability; PS-01 is the auth kernel and the wrong home; it inverts the MIT / self-host positioning. Three cheaper pieces carry the value. Written up below. |
| — | **PS-13 Signatures & Seals** | **Build when asked** | Envelopes, evidence packs and verification are software, and three modules already defer e-signature. QES stays behind a QTSP adapter we do not own. |

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
- **Reporting / Analytics.** This entry used to read "rejected — MOD-08 is a
  full module, source shared metrics from PS-07 and PS-02 instead." That answer
  is right about one question and never addressed the other, so it is split
  here. See the next entry.

- **Reporting, split in two.** There are two different services hiding under
  one name, and they deserve separate verdicts.

  **A service that PRESENTS reports** — query editor, pivots, charts, scheduled
  CSV exports, embeds. **Still rejected, and the original reasoning holds.**
  MOD-08 Reporting Suite *is* that, as a licensable module. A service version
  would duplicate a module we already ship.

  **A service that DELIVERS read models to consumers** — a place other software
  asks "what is true now" and gets a stable, documented answer that survives the
  owning module refactoring its tables. This was never actually weighed. It is
  a different job from presentation, and the old PS-07/PS-02 answer only covers
  half of it: **PS-07 answers "what happened" — an append-only event log — and
  a read model answers "what is true now."** MOD-08's job is the second kind. A
  receivables aging report is not a stream of events; it is the current balance
  per customer, and reconstructing it by folding an audit log would be both
  slower and less correct than asking the system that owns the data.

  **Chosen step: a view contract, not a service.** A module that wants to be
  reported on publishes `report_*` views in its own database; those views are
  its public contract and its tables stay private and refactorable. MOD-08 is
  pointed at the database and, with `SOURCE_VIEWS_ONLY` on, may read only those
  views. Full write-up in
  [`REPORTING-CONTRACT.md`](./REPORTING-CONTRACT.md); MOD-04 is the reference
  implementation.

  It wins on cost, and that is the whole argument. A service costs **another
  container in most stacks** — plus its volume, its secret, its healthcheck, a
  client in `platform/clients`, and a network hop on every query. The
  convention costs a migration in the module that opts in and a config flag in
  the module that consumes. It is also not throwaway work: the `report_*`
  contract is exactly what such a service would have to carry anyway, so
  adopting it now is the first step of that service rather than a detour
  around it. (This candidate was once penned in as "PS-12"; that number went to
  Banking, and no number is reserved for read models.)

  **The concrete trigger for revisiting it** — either one is enough:

  1. **A second consumer of cross-module read models.** Realistically MOD-02
     Admin Dashboard, which today has no cross-module data at all. One consumer
     reading one database over a mounted volume needs no service; two consumers
     wanting the same read models across several modules is a service, because
     that is the point where "each consumer mounts each volume" stops scaling
     and the contract needs an owner.
  2. **Reporting across hosts.** The view contract works because MOD-08 and its
     source share a stack on one host and one volume mount
     ([`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md)). A customer whose modules
     are split across hosts, or a need to report across customers, cannot be
     served by a file mount at all.

  Until one of those lands, a service here would be a container per customer
  bought with no consumer to spend it on.
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
5. Revisit **reporting read models** only on one of its two triggers above (a
   second consumer of cross-module read models, or reporting across hosts).
   Until then the `report_*` view contract is the answer, and rolling it out to
   a second module is the cheaper next move.
6. **PS-12 Banking** — built. Its write-up is below; the remaining work is
   downloads (camt.053, pain.002) and the first connection to a real bank.
7. ~~**Generic OIDC / SAML / SCIM in PS-01**~~ — **built, September 2026.**
8. **Assurance levels in PS-01**, then **PS-13 Signatures & Seals** once a
   customer asks for signing. Not an identity-verification platform — see the
   entry near the end of this document for why.

---

## PS-12 · Banking (built, port 4012)

**Purpose.** Speak EBICS 3.0 (H005) to the customer's own bank: hold the
subscriber's keys, run the key exchange, and upload signed ISO 20022 files.

**Why a service and not a module feature.** MOD-04 Invoice & Billing is the
first consumer and could have grown an EBICS client of its own. Three reasons
it did not:

1. **Key custody must happen in exactly one place.** An EBICS subscriber holds
   RSA private keys that — at signature class E, chosen here — are sufficient
   to move money. In a module they end up in every module that ever needs a
   bank, each with its own store, its own secret and its own bugs.
2. **A second consumer is already visible.** MOD-04 payables now; the
   bookings from `camt.053`, for receivables matching, next; payroll and MOD-06
   Procurement later.
3. **Modules stay standalone.** Integration is opt-in and best-effort like
   every other service: `BANKING_URL` unset and MOD-04 behaves exactly as it
   did before — the payment file is still downloadable, and always will be.

**What it gives every other module.** The API is deliberately payload-agnostic:
a caller hands over bytes, a BTF and an idempotency key, and gets an order whose
status it can poll. Nothing about invoices or bills is in the service, so a
module that can produce an ISO 20022 file reaches the bank in three lines — add
`BANKING_URL`, construct `BankingClient`, call `submitOrder`.

**The costs, stated plainly.** A container and a volume per stack that wants it,
and one secret — `EBICS_KEY_SECRET` — that is genuinely unrecoverable: losing it
means a new key exchange with the bank on paper. That is a real operational
burden, and it is the price of the keys living in one guarded place rather than
several unguarded ones.

**What is not proven.** Everything is tested against this repository's own
reading of the specification and, where an offline implementation existed,
cross-checked against it. No part of it has spoken to a real bank. The first
live connection should be treated as a debugging exercise.

### Revised: the camt.053 parser belongs here, not in the consuming module

The original write-up drew a line that this document repeated in several
places: an account statement is **downloaded, stored whole and handed over**,
because turning bookings into matched receivables is the business of the module
that has the invoices.

**That line was drawn one step too far out, and it is now corrected.** PS-12
reads a `camt.053` into bookings and offers them as a query
(`GET /api/entries`).

The mistake was collapsing two different things into one word. *Reading* a
camt.053 is understanding the format the bank speaks — which is the entire
reason this service exists. *Matching* a booking to an invoice is business
logic about invoices. Only the second belongs in a module, and the original
argument, which is sound, was about the second.

Leaving the parser out had the same shape as the mistake PS-12 was created to
avoid. An EBICS client in every module that wants a bank was rejected because
key custody must happen once; a camt.053 parser in every module that wants bank
data is the same duplication in a quieter form, and a worse one to debug:

- **The format has versions that differ materially and fail silently.**
  `camt.053.001.02` and `.08` disagree about where a counterparty's name sits
  (`Dbtr/Nm` versus `Dbtr/Pty/Nm`) and about whether `Sts` is a code or a
  choice. A reader written for one returns *null* on the other — for every
  booking, with no error. Every module would rediscover that separately, and
  some would not.
- **There is no natural place for the schemas.** PS-12 already vendors the
  EBICS, CIM and HAC schemas and validates fixtures against them before
  parsing. A module doing bank formats would need that apparatus too.
- **Amounts and directions are easy to get subtly wrong.** ISO 20022 never
  signs an amount; the direction is a separate indicator, a reversal undoes an
  earlier entry, and a pending entry is not money. Each of those is one wrong
  line away from an invoice marked paid that was not.

**What still belongs to the module, unchanged.** Which invoice a booking
settles, whether a customer is now paid up, what to do about a partial payment.
PS-12 answers *"what did the bank book"*; the module decides what that means. It
holds no notion of an entry being matched and should not gain one.

This does **not** reopen the reporting read-model question above. That candidate
is about serving *cross-module* views of data other modules own. This is a
service parsing the wire format of the protocol it already speaks, for data it
already holds — the same thing `payload.ts` does on the way out.

---

## Identity verification / eIDAS in PS-01 (don't build)

*Added September 2026, prompted by [signteq.io](https://signteq.io/en/) — an
eIDAS-first identity and onboarding platform — and the question of whether PS-01
should become one.*

**The question.** Signteq orchestrates identity *proofing* and trust services:
eID and NFC document reading, bank ident, photo ident with face liveness and
matching, PEP and sanctions screening, and qualified electronic signatures (QES)
with lifecycle management. Should PS-01 Identity grow into that — to strengthen
the catalog's market position and make the modules easier for companies to adopt?

**Verdict: no.** The word *identity* is doing all the work in that question.
PS-01 does authentication and authorization — who is this session, what may it
do. An ident platform does identity *proofing* — is this human the person on this
passport. They share a noun and almost nothing else: not the data, not the
threat model, not the legal footing, not the cost structure.

Three cheaper things carry most of the value that made the idea attractive, and
they are listed under [What to build instead](#what-to-build-instead) below.

### Why not: the product is regulatory status, not code

The orchestration code is the cheap part. What is actually being sold:

- **QTSP status.** Issuing *qualified* signatures means conformity assessment by
  an accredited CAB against the ETSI 319 4xx series, notification to the national
  supervisory body (RTR, in Austria), listing on the EU Trusted List, re-audit
  every two years, a certified QSCD/HSM for remote signing, and statutory
  liability with insurance behind it. Order of magnitude: a six-figure annual
  cost and 12–24 months before anything is sellable. That number is an estimate,
  not a quote — see [what is not proven](#what-is-not-proven-here).
- **Licensed data.** Official sanctions lists (EU, UN, OFAC) are free and could
  ship with the repo. Comprehensive PEP coverage and adverse media are licensed
  from Dow Jones / LSEG / ComplyAdvantage and are contractually not
  redistributable — so the part customers actually ask for cannot be MIT.
- **A contract per method.** Every eID scheme, every bank ident, every document
  library is its own integration *and* its own commercial agreement. Reading an
  NFC chip properly needs each country's CSCA certificates.
- **Special-category data and the liability that follows.** ID document images
  and face biometrics are Art. 9 GDPR data. Taking them moves 0815software from
  "here is MIT code, run it yourself" to being a processor with a DPA, a DPIA,
  TOMs, breach duties and insurance — for every customer, forever.

None of that is a build. It is a regulated business, and the catalog has no
mechanism for starting one.

### Why not here: PS-01 is the wrong home even if the answer were yes

From `platform/ps-01-identity/README.md`: *"This service is the one every other
package authenticates through — PS-02…12 all call `POST /api/tokens/verify`, and
the thirteen SSO modules delegate their login here — so a defect in it is a
defect everywhere."* It carries a 90% coverage gate for that reason.

Putting document upload, biometric processing and third-party webhooks inside
that process breaks the catalog's own rule — one cross-cutting job per service —
and takes the most load-bearing component in the platform from two runtime
dependencies and a deterministic offline test suite to an online, vendor-coupled
processor of Art. 9 data. The blast radius argument that justifies PS-01's
coverage gate is the same argument against widening it.

### Why not us: it inverts the catalog's positioning

The catalog wins on MIT, self-hostable, deterministic offline, no vendor
lock-in. An ident platform is proprietary by necessity, online-only,
per-transaction priced, and locks the customer to whichever vendors we picked.
It is a competitor on the exact axis where we currently differentiate.

The field is also crowded, and three of the incumbents are on our doorstep:
A-Trust (ID Austria), Namirial (via xyzmo, Ansfelden) and sproof (Salzburg),
alongside D-Trust, Swisscom Trust Services, Signicat and IDnow. Twentieth eIDAS
orchestrator is not a market position.

Worth watching separately: EUDI Wallets are landing across the EU now. Some of
what an orchestrator sells today — the proofing itself — is on a path to being
commoditised by them. That is an argument against entering as an orchestrator
and an argument for the relying-party seam below.

### What to build instead

The two goals behind the original question were "strengthen our position" and
"make it easier for companies to use our products." The second one argues
against the ident platform outright — KYC adds onboarding friction, it does not
remove it — and both are better served by the following, in order.

**1. Generic OIDC, SAML 2.0 and SCIM 2.0 in PS-01. Built — September 2026.** `server/oauth.ts` today hardcodes three providers (`google`,
`microsoft`, `github`) with hardcoded endpoints and no generic issuer. A
customer on Entra ID, Okta or Keycloak cannot plug in; neither can a public-sector
customer on ID Austria. MOD-09 lists "SSO/SAML" under *out of scope* for the same
reason. This is what actually stands between a module and an enterprise rollout,
it lives entirely inside PS-01's existing OAuth seam, and it is a sprint rather
than a business. **Effort: small–medium.**

**Built, with one decision that deserves recording.** OIDC and SCIM went in as
described, on `node:crypto` alone. SAML did not: it takes
`@node-saml/node-saml` (MIT), the first third-party dependency in this catalog
that is not `express` or `better-sqlite3`, loaded lazily so a deployment with
no SAML provider never touches it.

The reasoning, because "no auth libraries" was a real rule and this breaks it.
SAML's security rests on XML-DSig, and verifying XML-DSig means exclusive
canonicalisation, digest checking and — the part that bites — defending against
signature wrapping, where an attacker keeps the IdP's genuinely signed
assertion where a verifier will still find it and puts their own unsigned one
where the consumer reads. That class of bug **fails open**: the wrong
implementation does not error, it signs the attacker in.

The obvious objection is PS-12, which implements exclusive canonicalisation and
XML-DSig itself and takes nothing. The difference is direction. PS-12 *signs*,
with its own key, over a document it composed: no adversary chooses the input,
and a bug yields a signature the bank rejects — closed, loud, one counterparty.
PS-01's SAML *verifies* a document an attacker writes in full, and a bug yields
a session. Same primitive, opposite risk, different answer.

Two things fell out of building it that are worth knowing. node-saml enforces
its `idpIssuer` option on logout messages only — `verifyIssuer` is never called
on an authentication Response (5.1.0) — so PS-01 makes that check itself rather
than documenting one that does not run. And the library's in-memory replay
cache was replaced with a SQLite table, because losing every in-flight login on
restart is exactly the pressure that gets `validateInResponseTo` turned off.

Prefer OIDC wherever the customer's IdP offers it. SAML is for the ones that do
not, which in practice means older enterprise deployments and public-sector
federations such as the Austrian PVP2 profile.

**2. Assurance levels and step-up in PS-01. Build — this is the one interface
worth copying from Signteq.** Give PS-01 a verified-identity claim —
`{method, loa, verified_at, expires_at, evidence_ref, provider}` — surface `loa`
on `GET /api/me` and in the `POST /api/tokens/verify` claims, and let a route or
permission demand a minimum level (step-up). Deterministic mock verifier by
default, real ident providers behind config, exactly as PS-04 and PS-08 do.

The design line that makes this safe is worth stating explicitly: **PS-01 stores
the claim and an opaque reference, never the evidence.** No document images, no
biometric templates, no liveness video — those stay with whoever is licensed and
insured to hold them. That keeps the whole Art. 9 problem outside the platform
while still letting a module say "this action needs a substantial-assurance
identity," which is what regulated DACH verticals actually ask for.
**Effort: small.**

**3. PS-13 Signatures & Seals, as its own service (port 4013). Build when a
customer asks.** The demand is already written down in three module READMEs:
MOD-13 Offers says *"No e-signature, no PDF/A, no digital certificates"*, MOD-14
Subsidies defers e-signatures under out-of-scope, and MOD-09 Document Management
stores documents with no signing at all.

Unlike proofing, most of this *is* software, and the pieces are already here.

- **Envelopes and signers**: a document, an ordered signer list, per-signer
  HMAC-signed links — the same idiom MOD-13 already uses for acceptance links.
- **SES/AES in-house**: hash the document, record signing intent with timestamp
  and request metadata, chain it through PS-07 Audit Log, store bytes in PS-06
  File Storage.
- **Evidence pack**: the document hash chain, the audit trail and the signer
  records, exportable and independently re-verifiable via a `verify` endpoint.
- **QES only behind an adapter** to a QTSP *the customer chooses* — A-Trust,
  D-Trust, Namirial, Swisscom. Deterministic mock QTSP by default and offline,
  the PS-08 pattern. We never hold the qualified certificate and never need the
  audit.

This also reframes the market claim honestly: *"our stack signs with your QTSP"*
is a stronger and cheaper position than *"we are a QTSP."*

**Open decision.** PAdES-conformant PDF sealing is not something to hand-roll,
and a PDF library would be the first real runtime dependency in the catalog
beyond `express` and `better-sqlite3`. Either PS-13 takes that dependency
deliberately, or v1 seals a detached signature beside the file and leaves
embedded PAdES to the QTSP adapter. Recommendation: **the detached form for
v1** — it keeps the service in-ethos and the QTSP is producing the qualified
seal anyway. **Effort: medium.**

**4. An EUDI Wallet relying-party seam. Watch, don't build yet.** Verifying a
credential a wallet presents is a fundamentally cheaper posture than doing the
proofing, and it is where the regulation is heading. Revisit once wallets are
actually issuing in Austria and Germany and a customer asks.

### The failure mode to avoid

The bad outcome is not building the ident platform. It is the middle path: a
half-built KYC layer inside PS-01, too weak to be legally useful and too heavy
to keep the service boring — with the coverage gate and the "no runtime
dependencies" promise quietly abandoned to get there.

### What is not proven here

- **signteq.io was not read directly.** The session's network policy blocked the
  domain; the description above is assembled from search results and from the
  vendor category generally. If the site says something materially different,
  this entry should be corrected rather than trusted.
- **The QTSP cost and timeline are an order-of-magnitude estimate**, not a
  quote. Before any of this becomes a plan, get a real number from an accredited
  conformity assessment body.
- **The AI Act position is unassessed.** One-to-one biometric verification is
  argued to sit outside the high-risk remote-identification category, but that is
  a question for a lawyer, not for this document. It is another cost that lands
  on whoever does the proofing — which, under the recommendation above, is not us.

---

## Verification (per new service)

Same bar as the existing catalog: `npm test` green and fully offline; the
README quickstart `curl`s work against the mock provider; the `IDENTITY_URL`
seam accepts a PS-01 session when set and runs standalone when unset; a client
lands in `platform/clients` with an injected-fetch contract test; the service
is added to `platform/README.md`.
