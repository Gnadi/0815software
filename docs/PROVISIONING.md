# Provisioning: From a Module Selection to a Running Customer Deployment

*The release flow end to end. Companion to
[`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md), which decides the tenancy stance
this document automates.*

## The shape of it

A customer licenses a subset of the fifteen modules. That selection determines
everything else: which Platform Services have to run, which secrets exist, which
subdomains Caddy issues certificates for, whether a ticker sidecar is needed, and
which module-to-module bridges are wired. One command turns the selection into a
deployment, and one command proves the deployment works.

```
modules/registry.json          the source of truth: 15 modules, 11 services
        │
        ├─ deploy/provision.mjs      → customers/<name>/{docker-compose.yml, .env,
        │                              Caddyfile, README.md, manifest.json}
        │
        ├─ deploy/smoke-stack.mjs    → boots exactly that stack locally, in
        │                              production mode, and asserts it works
        │
        └─ deploy/test/registry.test.ts
                                     → re-derives every registry claim from each
                                       package's own server/config.ts (and
                                       server/db.ts for the view contract)
```

Nothing in that chain is hand-maintained twice. The marketing catalogue
(`src/data/modules.ts`), the local demo (`demo/serve.mjs`) and the hosted demo
hub read the same registry, so a new module is a package plus a registry entry.

## 1. The registry

[`modules/registry.json`](../modules/registry.json) declares, per module: its id,
catalogue number, slug, title, short operational label, default port, typical
scope, the Platform Services it integrates with, its module-specific env vars and
secrets, any module peers it bridges to, and four deployment constraints —
`supportsSso`, `needsPublicBaseUrl`, `acceptsSourceDb`, `publishesReportViews`.
It also carries the twelve
Platform Services with their ports, Caddy route prefixes, URL env var,
tick-driven flag and per-stack secrets.

Two properties make it trustworthy rather than decorative:

- **Every service is `optional` for every module.** That is the truth: platform
  coupling is opt-in, and each module's `server/platform.ts` degrades to
  `noopPlatform` when a URL is unset. `required` is reserved for a module that
  genuinely refuses to work, and nothing qualifies today.
- **A drift test re-derives every claim from the code.**
  `deploy/test/registry.test.ts` reads each package's own source and compares:
  ports, which `*_URL` vars are actually read, the four constraints (three
  against `server/config.ts`, `publishesReportViews` against the `CREATE VIEW
  report_*` statements in `server/db.ts`), the tick-driven flag, per-service
  secrets, and that no declared env var is fictional. Corrupt an entry and the
  suite fails naming the mismatch.

Adding a module: build the package, add a registry entry, add a copy block to
`src/data/modules.ts`. Adding a service: build the package, add a registry entry.

## 2. Generate the stack

```sh
node deploy/provision.mjs \
  --customer blaustern \
  --modules mod-04-invoice-billing,mod-13-offers \
  --domain blaustern.example.com \
  --out ./customers/blaustern \
  --acme-email ops@blaustern.example.com
```

What it decides for you:

- **The minimal service set.** MOD-04 + MOD-13 reference PS-01, PS-03, PS-06,
  PS-07, PS-08, PS-10 and PS-11 — seven, not twelve. Services nobody references
  are not started. `--all-services` overrides this when you want the full
  platform available for later.
- **Fresh secrets.** Every one generated with `randomBytes(32).toString('hex')`:
  per-service `SESSION_SECRET`, `ADMIN_PASSWORD`, `WEBHOOK_SECRET`,
  `SIGNING_SECRET`, PS-05's `INTEGRATION_ENCRYPTION_KEY`, PS-12's
  `EBICS_KEY_SECRET` (**see the warning below**), and per-module
  `ADMIN_PASSWORD` / `SESSION_SECRET` / `INTAKE_SECRET`. No two customers share a
  value and none is a repo default, which matters because every container runs
  `NODE_ENV=production` and the boot guard refuses known dev defaults.
- **Routing.** One subdomain per module from its registry label
  (`invoicing.`, `offers.`), plus the platform subpath routes for the included
  services on the bare domain.
- **The ticker** — only if the stack contains a tick-driven service (PS-02, 03,
  05, 08). A stack of PS-07 alone gets no sidecar.
- **Cross-cutting env.** Internal container URLs (`http://ps03:4003`),
  `IDENTITY_URL` only where the registry says `supportsSso` (so MOD-01/07/09
  never get one), `PUBLIC_BASE_URL` set to the module's real external URL where
  `needsPublicBaseUrl`, and persisted directories moved onto the volume.
- **Module bridges.** A registry `peers` entry is wired only when the peer module
  is in the *same* stack: a customer who licensed MOD-04 without MOD-13 gets no
  `OFFERS_URL`, and MOD-04's offer-import endpoint answers 501.

Two cases need attention:

- **MOD-08 Reporting Suite** *can* report on another module's database, opened
  read-only. This is **optional**: with no flag, MOD-08 is provisioned
  standalone against its own generated source database, which is a valid
  single-module stack. Pass `--source-db <module-id>` to point it at another
  selected module instead; the generator mounts that module's volume read-only
  at `/source`, sets `SOURCE_DB_PATH`, and makes MOD-08 wait for the owning
  module to be healthy, because a fresh volume has no database file yet.
  **If that module declares `publishesReportViews`, the generator also sets
  `SOURCE_VIEWS_ONLY=true`**, so MOD-08 is restricted to the published
  `report_*` views and never sees the source's private tables — no hand edit
  needed. A source that publishes no views is left unrestricted, because
  implying a contract that does not exist would restrict MOD-08 to nothing.
  The summary line says which case applied. See
  [`REPORTING-CONTRACT.md`](./REPORTING-CONTRACT.md).
- **Values only the customer can supply** — the seller name, address and VAT id,
  the ACME contact — are written as `FILL-ME-IN` and listed in the summary.

`--force` is required to overwrite a non-empty output directory.

### What lands in the directory

| File | What it is |
| ---- | ---------- |
| `docker-compose.yml` | The stack. Generated — re-run the generator, do not hand-edit. |
| `.env` | Every secret and setting. **This is key material.** |
| `Caddyfile` | TLS + routing for the domain and each module subdomain. |
| `README.md` | Bring-up, credentials, backup/restore, upgrade path. |
| `manifest.json` | The resolved selection. What an upgrade or an audit reads later. |

The generated directory belongs in the **customer's** private ops repository, not
this one — `/customers/` is gitignored here for that reason. Keep `.env` out of
version control wherever it lives, and back it up separately from the volumes: a
restored volume is useless with the wrong `SESSION_SECRET`.

## 3. Prove it before it goes live

```sh
node deploy/smoke-stack.mjs --manifest ./customers/blaustern/manifest.json
# or through npm:  cd deploy && npm run predeploy -- --manifest <path>
```

No Docker. It boots exactly the services and modules in the manifest as local
processes, in production mode, with freshly generated secrets, and asserts:

- every service and module answers `/api/health` and `/api/ready`;
- every platform URL wired into a module is reachable, every declared module
  bridge resolves, PS-11 resolves a party, and PS-07's audit chain verifies;
- **each module still boots standalone**, with no service URLs at all, and serves
  its API — the guarantee the whole catalogue is sold on, checked rather than
  assumed;
- single sign-on works for the modules the registry marks `supportsSso` and is
  *absent* for the ones it does not;
- security headers are present on module responses;
- the boot guard really refuses a default secret (a module and a service are each
  spawned with one and must exit non-zero);
- the generated `.env` has no `FILL-ME-IN` left, no value a boot guard would
  reject, and defines every variable the compose file references.

A seven-service stack takes about ten seconds. All fifteen modules against every
service takes about twenty.

`deploy/smoke.mjs` is the narrower, older check: every Platform Service, no
modules. Use it to validate a checkout before building images.

## 4. Bring it up

```sh
cd customers/blaustern
$EDITOR .env                 # fill in every FILL-ME-IN
docker compose up -d --build
docker compose ps            # every container should become healthy
```

DNS for the platform domain **and every module subdomain** must point at the host
before the first start, or Caddy cannot complete the ACME challenge.

## 5. Upgrade

```sh
cd <repo> && git pull
cd customers/blaustern && docker compose up -d --build
```

Schema migrations are append-only and idempotent and apply on boot, so rolling a
customer forward is pull + rebuild + restart. Re-run the stack smoke test
afterwards.

**If the selection changed** — the customer licensed another module — re-run
`provision.mjs` with `--force`. It regenerates `docker-compose.yml` and
`Caddyfile` from the new selection; then reconcile `.env` by hand so the secrets
you are already running with survive, adding only the new entries. `manifest.json`
records what the previous run resolved, which is what makes that diff readable.

### ⚠️ PS-12's `EBICS_KEY_SECRET` is not like the other secrets

`generateSecrets` mints a fresh random value for **every** declared secret on
every run, `--force` included. For the other secrets that is a nuisance: a
rotated `SESSION_SECRET` logs everyone out, and the fix is to log back in.

`EBICS_KEY_SECRET` encrypts the RSA private keys that sign payments. Rotating it
does not log anyone out — it makes every stored bank key undecryptable, and the
only recovery is a fresh key exchange with the bank: new keys, a new INI letter,
signed by hand and posted, and days of no payments while it is processed.

So when a stack contains PS-12, **copy the running `EBICS_KEY_SECRET` into the
regenerated `.env` before bringing the stack back up**, and keep a copy of it
wherever that customer's other unrecoverable material lives. PS-12 refuses to
boot when the configured secret cannot decrypt what is already stored, which
turns this from silent data loss into a startup failure — but the backup is
what actually saves you.

Back it up **before the first key is generated**, not after the first payment.
[`platform/ps-12-banking/FIRST-CONNECTION.md`](../platform/ps-12-banking/FIRST-CONNECTION.md)
is the runbook for bringing a real bank connection up, and that is step 0 in it.

## 6. Decommission

```sh
docker compose down -v
```

All of that customer's data is on those volumes, so that is the whole erasure —
which is the point of one stack per customer.

## Non-goals

- **No shared multi-tenant instance.** Unchanged; see
  [`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md).
- **No orchestration beyond Compose.** A per-customer stack is a handful of Node
  processes on SQLite; a single modest VM is the expected footprint. Kubernetes
  would be a different document, not a flag.
- **No secret manager integration.** The generator writes a `.env` because that
  is what Compose reads. Piping those values out of a vault instead is a
  deployment-time substitution, deliberately left to the operator.
- **The generator does not talk to anything.** It writes files. It never contacts
  a host, a registry or a DNS provider, so it is safe to run and diff repeatedly.

## Provisioning a stack with MOD-15 Workspace

Nothing extra to pass. When the selection includes `mod-15-workspace`, the
generator wires it to every other module in that stack — `<MODULE>_URL` for the
internal address it reads summaries from, `<MODULE>_PUBLIC_URL` for the origin
a browser uses to frame or link to it — and sets `SHELL_ORIGIN` on every module
whose registry entry has `constraints.embeddable`.

That reciprocity is what turns on framing and session handoff. It is deliberately
NOT in the registry: whether a module is framed depends on whether the customer
licensed a shell, which is a property of the selection rather than of the module.
A stack without the Workspace leaves `SHELL_ORIGIN` unset everywhere, and every
module keeps its blanket `X-Frame-Options: DENY`.

Three modules never receive it — MOD-01, MOD-07 and MOD-09 — because their end
users are not staff. They appear on the board as figures and open in a new tab.
See [`SHELL-CONTRACT.md`](./SHELL-CONTRACT.md).
