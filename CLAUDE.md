# CLAUDE.md

Guidance for coding agents (and humans) working in this repository. Read it
before changing anything; the root [README](./README.md) has the full picture.

## What this is

Standard business software, MIT-licensed. Two independent catalogues:

- `modules/` — **Business Modules** (`mod-NN-<slug>`): complete applications.
- `platform/` — **Platform Services** (`ps-NN-<name>`): shared backend
  capabilities, plus `platform/clients` (typed clients, one per service).

Dependencies point one way only: **modules → services → infrastructure**. A
service never depends on, imports from or names a module. A module talks to a
service over HTTP through `@0815software/platform-clients`, never by reaching
into its code or database.

## Rules that are not negotiable

1. **Every package installs, runs and tests on its own.** No root workspace,
   no shared `node_modules`. Platform integration is **opt-in and best-effort**:
   with the `*_URL` env vars unset a module makes no outbound call, and a
   service outage never fails the local operation.
2. **Multi-user by default — never write "one staff admin by design" again.**
   People get a level per module from PS-01 (`module:<slug>:view|edit|manage`).
   The session carries it; `server/auth.ts` enforces it on every `/api`
   request against **one** policy file, `server/access.ts` (reads → `view`,
   writes → `edit`, listed exceptions). Routes do not check levels themselves;
   a rule that depends on the row is one named function beside the policy
   (MOD-11 `server/ownership.ts`). Screens hide what the level forbids
   (`src/access.tsx`). The standalone local admin always manages. Contract:
   [`docs/ACCESS-LEVELS.md`](./docs/ACCESS-LEVELS.md).
3. **Derived, never stored.** Totals, balances, stock levels, SLA timers,
   deadlines are computed from the rows they come from. Money is integer
   cents. History is append-only. Each module README names its invariants and
   the tests that pin them — keep that section true.
4. **Every write names the person.** `actorOf(res, auth)` goes on audit events
   and history rows; never a service account.
5. **Fail closed, loudly.** Production refuses to boot with default or blank
   secrets (`server/guard.ts`); bad config throws at start-up rather than
   falling back silently (`numberFromEnv` in `config.ts`).
6. **No new runtime dependencies** without a reason written down. Server:
   `express` + `better-sqlite3` + Node built-ins (crypto included — no auth,
   ORM or validation libraries). Client: React + Vite.
7. **Domain law comes with its source.** E-invoicing, SEPA, EBICS, tax: test
   against the published schema or reference vectors (see MOD-04's
   `sepa-schema.test.ts`, PS-12's suites). Plausible-looking output is not
   evidence.

## Copy-in files

Some files are carried by every module, identical apart from the module's own
number: `server/auth.ts`, `sso.ts`, `handoff.ts`, `hardening.ts`, `guard.ts`,
`shared/summary.ts`, `scripts/backup.mjs`, the tsconfigs, and the tests
`access`, `handoff`, `transport-hardening`, `config-env`, `upgrade`. Change one
→ change it in **every** module that has it (a script, not by hand), and run
each suite. `deploy/test/new-module.test.ts` fails when they drift apart.

## Adding a module

```sh
node scripts/new-module.mjs --n 18 --slug appointments \
  --title "Appointment Booking" --label Appointments --description "…" --register
```

**First ask whether it is a module at all.** The generator checks the topic
against every existing module (registry + README) and refuses while one already
covers it: extend that module instead — absences, flexitime and project
planning all went into MOD-11, not into modules of their own. If it truly stands alone, re-run with
`--justify "<why this is not part of MOD-xx>"`; the reason goes into the README.

It writes a working module (copy-ins from MOD-03, an example domain from
`scripts/module-template/`, tests green from the first `npm test`) and prints
the remaining manual steps. Then: replace the example domain, write
`server/access.ts`, write the README (invariants, API, **Out of scope**).
Details: [`docs/PROVISIONING.md`](./docs/PROVISIONING.md).

`modules/registry.json` is a **source of truth**: the site, the demos and
`deploy/provision.mjs` derive from it, and `deploy/test/registry.test.ts`
re-derives every claim from each package's `server/config.ts`. A new env var,
secret, service or peer goes in both, or the drift suite fails.

## Building and testing

```sh
# ALWAYS first: modules copy the clients package (file: link), dist included
cd platform/clients && npm ci && npm run build

cd modules/mod-04-invoice-billing && npm ci && npm test   # one module
cd platform/ps-01-identity && npm ci && npm test          # one service
cd deploy && npm ci && npx vitest run                     # registry + drift guards
npx tsc -p tsconfig.json --noEmit                          # in any package
```

After changing `platform/clients`, rebuild it and **reinstall** the modules
(`npm ci`) — they hold a copy, not a link. CI (`.github/workflows/test.yml`)
runs every package's suite; nothing needs network or Docker.

## Where things are

| Need | Look at |
| --- | --- |
| Module ↔ shell (dashboards) | `docs/SHELL-CONTRACT.md`, `shared/summary.ts` |
| Users, roles, access levels | `docs/ACCESS-LEVELS.md`, `server/access.ts`, PS-01 |
| Customer master data | `docs/CUSTOMER-MASTER-DATA.md`, PS-11 |
| Reporting views (`report_*`) | `docs/REPORTING-CONTRACT.md` |
| Deploying a customer stack | `docs/PROVISIONING.md`, `deploy/` |
| What personal data lives where | `docs/PII-MAP.md` |
| Gaps vs. Odoo, module roadmap | `docs/ODOO-GAP-ANALYSIS.md` |

## Style

- TypeScript strict, ESM, `.js` suffixes on relative imports in server code.
- Comments explain **why** — the failure a line prevents, the trade-off it
  makes — not what the next line does. Match the density of the file you edit.
- Errors: `{ error, details? }`; 422 validation, 401 no session, 403 level too
  low, 404 not found (also for another tenant's or customer's data), 409 state
  conflict.
- Commits: imperative subject saying what changes for the reader ("Give every
  module per-person access levels"), body explaining why.
