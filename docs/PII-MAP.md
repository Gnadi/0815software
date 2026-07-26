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
| **PS-11 Customers** | Party master data: customer name, contact person, email, VAT id, postal address, IBAN/BIC — this is now the **primary** copy for the modules that consume it, not a mirror | `POST /api/parties/:id/erase` anonymizes name/contact/email/VAT id/address/bank details in place and archives the party, keeping the row, its id and its `party_refs` so every module's foreign reference stays valid (the same stance PS-01 takes for users). `POST /api/parties/:id/archive` retires a party without erasing it; archived parties are never matched by `resolve`. |

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
  guided by this map.
