# PII Map & Data-Retention Levers

Where personal data lives across the Platform Services, and the lever that
bounds or removes it. This is the reference for a customer's DPA / GDPR
obligations. Tenancy is **per-customer deployment** (see
[`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md)), so each customer's data is
already isolated at the deployment boundary — this map covers what lives inside
one customer's stack.

## Platform Services

| Service | Personal data it holds | Retention / erasure lever |
| --- | --- | --- |
| **PS-01 Identity** | User email, name, password hash, org membership, auth-event IPs | `POST /api/users/:id/erase` anonymizes email/name, scrambles the password, bumps `token_version` (kills live sessions) and disables the account, keeping the row+id for referential integrity. Records a `user_erased` audit event. |
| **PS-02 Workflow** | Whatever the caller puts in event/instance `payload`/`input` (may reference people) | No dedicated PII store; payloads are caller-controlled. Bound at the source module; instances can be deleted by the operator. |
| **PS-03 Notification** | Recipient address (email/phone), message subject/body (often personal) | `RETENTION_DAYS` prunes **sent** and **dead** messages on tick (`pruneMessages`). In-flight (`queued`/`failed`) messages are never pruned. |
| **PS-04 AI Platform** | Prompt/response text and RAG documents (may contain personal data) | Completions and RAG docs are caller-supplied; delete by collection / row. No long-term requirement to keep completions. |
| **PS-05 Integration** | Third-party **credentials** (AES-256-GCM encrypted, never returned), external account ids | Credentials are encrypted at rest with `INTEGRATION_ENCRYPTION_KEY`; deleting a connection removes them. |
| **PS-06 Files** | Object contents + metadata (whatever is uploaded) | Objects deleted via `DELETE /api/objects/:bucket/:key`; buckets are operator-managed. |
| **PS-07 Audit** | Actor ids, and before/after snapshots that may embed personal data | `POST /api/rotate` + `RETENTION_DAYS` prune events older than the window while advancing the hash-chain anchor, so the tamper-evident chain still verifies over the surviving events. |
| **PS-08 Payments** | Payment reference, amounts, PSP ids (pseudonymous); no card data (that stays at the PSP) | Intents/ledger are financial records — typically retained for statutory periods, not erased. No raw PAN is ever stored. |
| **PS-09 Search** | Indexed titles/bodies/facets (mirror of source records, may be personal) | Index is an upsert mirror; `DELETE /api/index/:collection/:id` removes a document. Re-index from source is the source of truth. |
| **PS-10 Number** | None (sequence counters only) | n/a |
| **PS-11 Customers** | Party master data for customers **and suppliers**: name, contact person, email, VAT id, postal address (both the printed lines and the structured street/post code/city/country fields EN 16931 needs), IBAN/BIC — this is the **primary** copy for the modules that consume it (MOD-04, MOD-06, MOD-10, MOD-13), not a mirror. Also the stack owner's own `self` party, which is company data rather than personal | `POST /api/parties/:id/erase` anonymizes name/contact/email/VAT id/address (printed and structured alike — a street and post code identify a sole trader exactly as the lines do)/bank details in place and archives the party, keeping the row, its id and its `party_refs` so every module's foreign reference stays valid (the same stance PS-01 takes for users). `POST /api/parties/:id/archive` retires a party without erasing it; archived parties are never matched by `resolve`. A merged-away party keeps its row as a redirect, so erasing the **survivor** is what removes the identity. |

## Modules

Modules hold the domain data (customers, employees, invoices, tickets…). Each
owns its own SQLite database and is responsible for its records' lifecycle. The
platform-side levers above cover the **copies** that flow into the services
(audit snapshots, notification bodies, search index, AI prompts) — with one
exception: where a module consumes **PS-11 Customers**, the party record there is
the primary copy of that customer's identity and the module's own row is a handle
on it. Erasing a customer in a stack with PS-11 therefore means erasing the party
*and* clearing the module-local copies. When a module
erases a person, it should also: call PS-01 erase if that person is a platform
user, delete their PS-09 index documents, and rely on PS-03/PS-07 retention to
age out message bodies and audit snapshots.

## Subject access & portability (Art. 15 / 20)

"Send me everything you hold about me" arrives with a one-month deadline, and
reading SQLite files by hand is not an answer. Each service that holds
subject-addressable personal data exposes `GET /api/export?subject=<email>`:

| Service | What it returns |
| --- | --- |
| **PS-01 Identity** | The user account (never the password hash), their roles, their auth events, API keys they minted — and failed logins recorded under an address with no account, which are still a trace about that person. Scoped to the caller's organization; requires `user:write`, not the directory-level `user:read` that every role down to viewer holds. |
| **PS-03 Notification** | Messages sent to that address, with subject and body — an invoice mail is personal data with content — plus their delivery events. |
| **PS-07 Audit** | Events they caused (`actor`), and events that merely mention them: a before/after snapshot can embed someone's data without their name ever being the actor. An export never deletes; the chain is append-only, and erasure there is the retention window instead. |
| **PS-11 Customers** | The party master record (the PRIMARY copy, not a mirror), its per-module references — which say which other systems here hold a row about the same person — and any duplicate merged into it. |

The other services hold nothing addressable by a data subject: PS-02/PS-04
hold caller-supplied payloads bound at the source module, PS-05 holds
third-party credentials, PS-06 opaque objects, PS-08 pseudonymous financial
records, PS-09 a mirror of module records, PS-10 counters.

`deploy/export-subject.mjs` fans out across one customer's stack and assembles
a single report:

```sh
node deploy/export-subject.mjs --manifest ./customers/xy/manifest.json \
  --subject ada@example.com --out ada.json
```

**Read the report's `gaps` before sending it.** The modules hold the domain
records — this person's invoices, tickets, time entries — and have no export
endpoint yet, so every module in the stack is listed as a gap with what to
inspect instead, and `complete` is `false` whenever anything was missed. A
service that could not be reached is recorded as a gap too, never as an empty
source: a service that is down must not read as a service with nothing to say.

## Configuring retention

Set `RETENTION_DAYS` on the services that support it (PS-03, PS-07). `0` (the
default) keeps data indefinitely — appropriate for audit/financial records
where statutory retention applies, but review per customer/DPA. PS-07's
`/api/rotate` and PS-03's tick apply the window; schedule them via the
deployment's ticker/cron.

## Deliberately deferred

- **e-invoicing archival** (ZUGFeRD/XRechnung long-term storage) — tracked in
  [`PLATFORM-READINESS.md`](./PLATFORM-READINESS.md) D2.
- **Automated cross-service erasure orchestration** (one "erase this person"
  call fanning out to every service) — today it is the operator/module's job,
  guided by this map. The read side of that fan-out now exists
  (`deploy/export-subject.mjs`); the write side does not, deliberately, because
  an erasure that half-succeeds across four services is worse than one an
  operator performs deliberately.
- **Module-side subject export.** The platform services answer for themselves;
  the fourteen modules do not, so a subject access request still needs a manual
  pass over the module holding that person's domain records. The fan-out names
  each one rather than hiding the gap.
