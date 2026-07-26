# Business Modules

**This directory contains Business Modules only** — complete,
customer-facing applications that each solve an end-user problem on their
own. It holds no shared backend services; those live in the
[Platform Services catalog](../platform/README.md), and modules consume
them over APIs. The two catalogs are independent (see the
[architecture overview](../README.md#architecture)).

The 0815software module catalogue: fourteen standard modules for standard
business problems, each shipped MIT-licensed with full source code. This
directory holds the implementations. **All fourteen modules are now
available**: MOD-01 Customer Portal, MOD-02 Admin Dashboard, MOD-03 Inventory
Management, MOD-04 Invoice & Billing, MOD-05 Employee Directory, MOD-06
Procurement Tracker, MOD-07 Storefront, MOD-08 Reporting Suite, MOD-09
Document Management, MOD-10 CRM Lite, MOD-11 Time Tracking, MOD-12 Support
Ticket System, MOD-13 Offers and MOD-14 Subsidies & Funds. See the
[catalogue page](https://0815software.com/modules) for scopes and
descriptions.

| #      | Module                | Status      | Source                                             |
| ------ | --------------------- | ----------- | -------------------------------------------------- |
| MOD-01 | Customer Portal       | **Available** | [mod-01-customer-portal](./mod-01-customer-portal) |
| MOD-02 | Admin Dashboard       | **Available** | [mod-02-admin-dashboard](./mod-02-admin-dashboard) |
| MOD-03 | Inventory Management  | **Available** | [mod-03-inventory-management](./mod-03-inventory-management) |
| MOD-04 | Invoice & Billing     | **Available** | [mod-04-invoice-billing](./mod-04-invoice-billing) |
| MOD-05 | Employee Directory    | **Available** | [mod-05-employee-directory](./mod-05-employee-directory) |
| MOD-06 | Procurement Tracker   | **Available** | [mod-06-procurement-tracker](./mod-06-procurement-tracker) |
| MOD-07 | Storefront            | **Available** | [mod-07-storefront](./mod-07-storefront) |
| MOD-08 | Reporting Suite       | **Available** | [mod-08-reporting-suite](./mod-08-reporting-suite) |
| MOD-09 | Document Management   | **Available** | [mod-09-document-management](./mod-09-document-management) |
| MOD-10 | CRM Lite              | **Available** | [mod-10-crm-lite](./mod-10-crm-lite) |
| MOD-11 | Time Tracking         | **Available** | [mod-11-time-tracking](./mod-11-time-tracking) |
| MOD-12 | Support Ticket System | **Available** | [mod-12-support-tickets](./mod-12-support-tickets) |
| MOD-13 | Offers                | **Available** | [mod-13-offers](./mod-13-offers) |
| MOD-14 | Subsidies & Funds     | **Available** | [mod-14-subsidies-funds](./mod-14-subsidies-funds) |

Each module is a self-contained application with its own `package.json`,
`LICENSE` and README — install and run it independently of this repository.

## The registry — `registry.json`

[`registry.json`](./registry.json) is the machine-readable description of the
catalogue: for every module its id, catalogue number, slug, title, operational
label, default port, typical scope, the Platform Services it integrates with,
its module-specific env vars and secrets, and its deployment constraints
(SSO-capable, needs a public base URL, needs a co-located source database).
The same file carries the ten Platform Services with their ports, Caddy route
prefixes, URL env var, tick-driven flag and per-stack secrets.

It is a **source of truth, not documentation**: the marketing catalogue
(`src/data/modules.ts`), both demo hubs, `deploy/provision.mjs` and
`deploy/smoke-stack.mjs` all derive from it, and
`deploy/test/registry.test.ts` re-derives every claim from each package's own
`server/config.ts` — so a registry entry that disagrees with the code fails
the build rather than misleading a generator.

- Schema: [`registry.schema.json`](./registry.schema.json) (JSON Schema 2020-12)
- Loader for scripts: [`registry.mjs`](./registry.mjs) — plain ESM, plus
  `resolveSelection()`, which turns a module selection into the minimal stack
- Loader for TypeScript: [`registry.ts`](./registry.ts)

Adding a module means: the package, a registry entry, and a copy block in
`src/data/modules.ts`. See [`docs/PROVISIONING.md`](../docs/PROVISIONING.md).

## Consuming the Platform Services

Modules talk to the [Platform Services](../platform) through the shared
[`@0815software/platform-clients`](../platform/clients) package — one typed
client per service over the built-in `fetch`. Integration is always **opt-in
and best-effort**: a module reads the relevant `*_URL` + `PLATFORM_SERVICE_TOKEN`
env vars and, when they are set, delegates a cross-cutting concern (identity,
notifications, workflow, AI, integrations, files, audit) to the service;
unset, the module keeps its standalone behavior with no outbound calls, and a
downstream outage never fails the local operation.

**All fourteen modules ship this wiring** (each has a `server/platform.ts` and
a README "Platform integration" section). The richest consumers: MOD-04
Invoice & Billing → PS-03/06/07/08, MOD-07 Storefront → PS-08 checkout, MOD-12
Support Tickets → PS-03/04/07, MOD-09 Document Management → PS-06 (+ PS-07),
MOD-13 Offers → PS-03 (+ PS-07). Every other module records its key state
changes on PS-07 Audit Log. All integrations are opt-in and best-effort, so
each module still installs and runs standalone with the `*_URL` env vars unset.
