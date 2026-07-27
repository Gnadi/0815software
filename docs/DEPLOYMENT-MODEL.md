# Deployment Model: One Platform Stack per Customer

*The tenancy stance for the 0815software platform. Decided July 2026 during
the customer-readiness campaign (closes readiness item A7).*

## The stance

**Each customer runs their own platform instance.** A deployment is one stack:
the Platform Services that selection needs (PS-01…11 exist; a two-module
stack usually needs seven), the modules that customer licensed, one
set of secrets, and one set of SQLite database files — all owned by and
dedicated to that customer.

Isolation is therefore enforced at the **deployment boundary**, not inside the
services:

- separate containers/processes per customer,
- separate volumes (every service's `DATABASE_PATH`, PS-06 blobs, backups),
- separate secrets (`SESSION_SECRET`s, `SERVICE_TOKEN`s, encryption keys —
  generated per customer, never shared),
- separate hostnames/TLS certificates.

There is **no shared platform instance serving multiple customers**, so no
query in PS-02…11 ever needs a tenant filter: everything in a database belongs
to the one customer whose stack it is.

## Why this model

- It matches the business: 0815software delivers standard software
  **per customer** (agency model), and the fourteen modules are themselves
  single-tenant applications (one admin realm, one organization).
- It is the strongest isolation available — a bug can never leak another
  customer's data, because another customer's data is not on the machine.
- It keeps the platform's defining property: self-contained services on
  single-file SQLite, trivially backed up (`npm run backup`) and restored
  per customer.
- It removes the largest open work item (threading tenant scope through eight
  services' schemas and queries) without weakening any customer guarantee.

PS-01 remains internally multi-org (orgs/users/roles) — useful for a customer
with subsidiaries — and PS-09 keeps its `tenant` column; both are *within* one
customer's stack. PS-11 Customers holds that one customer's customer list, not a
global one, for the same reason.

## Operational consequences

- Provisioning a customer = `node deploy/provision.mjs` with their module
  selection, which generates the stack with freshly generated secrets and only
  the services that selection references (see
  [`PROVISIONING.md`](./PROVISIONING.md)). The production boot guard refuses
  default secrets, so an unconfigured stack cannot start.
- Upgrades roll per customer: pull new images, restart; each service applies
  its pending schema migrations on boot (`server/migrations.ts`).
- Backups, retention, and GDPR erasure are per customer by construction —
  deleting a customer is deleting their stack and volumes.
- Cost scales linearly with customers. The stack is small (ten Node processes
  + SQLite), so a single modest VM per customer is the expected footprint.

## Explicit non-goal — and the escape hatch

A **shared multi-tenant SaaS instance** is a non-goal of this platform
version. If that ever flips (e.g. a high-volume, low-touch self-serve
product), the work is known and bounded: thread the PS-01 principal's org
through every service table and query (PS-09's `tenant` column is the
precedent), enforce cross-tenant 404s with tests, and move hot services off
single-writer SQLite. Until then, per-customer deployment is the supported —
and safer — model.
