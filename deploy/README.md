# Deployment

One platform stack for **one customer** — see
[`docs/DEPLOYMENT-MODEL.md`](../docs/DEPLOYMENT-MODEL.md) for the tenancy
stance.

There are two ways in:

- **[`provision.mjs`](#provisioning-a-customer-stack) — generate a stack from
  a module selection.** This is the normal path: pick the modules the customer
  licensed and get a compose file, fresh secrets, TLS routing, a README and a
  manifest, with exactly the Platform Services that selection needs.
- **`docker-compose.yml` in this directory — the reference platform stack.**
  All eleven services, no modules, hand-maintained. It is the shape a generated
  stack is modelled on and what you bring up to evaluate the platform alone.

Read [`docs/PROVISIONING.md`](../docs/PROVISIONING.md) for the release flow
end to end.

## Provisioning a customer stack

```sh
node deploy/provision.mjs \
  --customer blaustern \
  --modules mod-04-invoice-billing,mod-13-offers \
  --domain blaustern.example.com \
  --out ./customers/blaustern
```

Reads [`modules/registry.json`](../modules/registry.json), resolves the
selection to the **minimal** set of Platform Services those modules actually
reference (the two above need seven, not eleven), and writes `docker-compose.yml`,
`.env`, `Caddyfile`, `README.md` and `manifest.json`. Every secret is generated
fresh with `crypto.randomBytes(32)`, so no two customers share one and none is
a repo default. Values only the customer can supply — the seller VAT id, the
ACME contact — are written as `FILL-ME-IN` and listed in the summary.

Each module gets a subdomain (`invoicing.<domain>`, `offers.<domain>`); the
Platform Services keep their subpath routes on the bare domain. The ticker
sidecar is included only when the stack contains a tick-driven service.

Useful flags: `--all-services` (include every service regardless of the selection),
`--source-db <module-id>` (optional — point a module that accepts a source
database, i.e. MOD-08, at another selected module's volume instead of its own
data; when that module declares `publishesReportViews` the consumer is
restricted to those views automatically via `SOURCE_VIEWS_ONLY=true`), `--org`
(PS-01 organization slug, defaults to the customer), `--acme-email`, `--force`
(overwrite a non-empty `--out`), `--help`.

Run `node deploy/provision.mjs --help` for the full list and the module ids.

## Smoke-testing a stack before it goes live

```sh
node deploy/smoke-stack.mjs --manifest ./customers/blaustern/manifest.json
# or, without generating a stack first:
node deploy/smoke-stack.mjs --modules mod-04-invoice-billing,mod-13-offers
```

Boots exactly the services and modules in the manifest as local processes — no
Docker — in production mode with freshly generated secrets, and asserts:

- every service and module answers `/api/health` and `/api/ready`;
- every platform URL wired into a module is reachable, and PS-07's audit chain
  verifies;
- each module still boots **standalone**, with no service URLs at all, and
  serves its API — the guarantee the whole architecture rests on;
- single sign-on works for the modules the registry marks `supportsSso`, and is
  absent for the ones it does not (MOD-01/07/09);
- security headers are on module responses, not only service responses;
- the production boot guard really does refuse a default secret;
- the generated `.env` has no `FILL-ME-IN` left, no value a boot guard would
  reject, and defines every variable `docker-compose.yml` references.

A seven-service customer stack runs in ~11s; all 14 modules against every
service in ~21s. `cd deploy && npm run predeploy -- --manifest <path>` is the
same thing through npm, and the generated customer README points the operator
at it.

`deploy/smoke.mjs` remains the narrower check: every service, no modules.

## Tests

```sh
cd deploy && npm install && npm test
```

Offline, no Docker: the registry drift suite (every registry claim re-derived
from each package's own `server/config.ts`) plus the provisioning suite
(service resolution, ticker logic, secret uniqueness, the MOD-08 source-db
rules, clobber refusal, and the invariant that every `${VAR}` in a generated
artifact is defined in the generated `.env`).

## Reference stack bring-up

```sh
cd deploy
cp .env.example .env
# Replace every CHANGE-ME (openssl rand -hex 32) and set PLATFORM_DOMAIN.
docker compose up -d --build
docker compose ps          # all services should become healthy
```

Every container runs with `NODE_ENV=production`, so the **boot guard refuses
to start** while any secret still carries a known dev default — an
unconfigured stack cannot come up half-secured.

Routing (via Caddy on `https://$PLATFORM_DOMAIN`):
`/identity` → PS-01, `/workflow` → PS-02, `/notify` → PS-03, `/ai` → PS-04,
`/integrations` → PS-05, `/files` → PS-06, `/audit` → PS-07,
`/payments` → PS-08, `/search` → PS-09, `/number` → PS-10,
`/customers` → PS-11.

## Tickers

The `ticker` sidecar POSTs `/api/tick` to PS-02/03/05/08 once a minute with
the service token (advancing schedulers, delivery queues, sync jobs, and mock
settlements). Alternatively set `TICK_INTERVAL_MS` on those services to use
their in-process timers.

## Observability

Every service exposes `GET /api/ready` (DB reachable + schema fully
migrated — this is what the compose healthchecks poll) and `GET /api/metrics`
(Prometheus text format): request counters by route/status plus domain gauges
— dead-lettered deliveries/messages (PS-02/03), pending sync jobs (PS-05),
stuck payment intents (PS-08), and PS-07's `audit_chain_valid` (0 = the
tamper-evident chain is broken — alert on it). Services log one JSON line per
request with an `X-Request-Id` that is propagated when supplied by the caller.

## Monitoring

A generated stack ships `monitoring/` (Prometheus, Alertmanager,
blackbox-exporter) behind a compose profile:

```sh
cd /opt/customers/xy
$EDITOR monitoring/alertmanager.yml     # a real receiver goes here
docker compose --profile monitoring up -d
```

Prometheus scrapes each service's `/api/metrics` — request counters plus the
domain gauges — and probes `/api/ready` on every service **and** module through
blackbox-exporter, because the modules publish no Prometheus metrics of their
own. The alert rules are generated for the stack's actual selection, so a rule
can never watch a metric nobody publishes: `deploy/test/monitoring.test.ts`
re-derives every target from the plan and every metric name from that service's
source.

The rules cover a container down or unready and sustained 5xx, plus the
failures that are otherwise silent: a queue that stops draining (the ticker
died, and mail is quietly not going out), dead letters, payments stuck in
processing, and an audit chain that no longer verifies.

Alertmanager is deliberately not routed through PS-03 — an alerting path
through the system it watches goes quiet exactly when it matters.

## Backups

```sh
./backup.sh                      # the reference stack in this directory
./backup.sh /opt/customers/xy    # a stack generated by provision.mjs
```

Schedule it from the host's cron (e.g. `0 2 * * *`). It asks the stack which
containers are running and snapshots every one that ships `scripts/backup.mjs`
— all eleven services **and** every module, which is where the invoices,
offers and tickets are. Each snapshot is online-consistent (better-sqlite3's
backup API, never a file copy of a live database) and lands in `/data/backups`
on that container's own volume. The three modules that keep files beside their
database (MOD-01 documents, MOD-08 exports, MOD-09 storage) copy those too — a
database without them restores a catalogue of things that are gone.

**Restore** = stop the container, replace `/data/data.db` with a snapshot (and
the files directory beside it, for those three), start it again; pending schema
migrations apply on boot. This is covered by tests that really do destroy a
database and read the data back out afterwards — see
`modules/mod-04-invoice-billing/test/backup-restore.test.ts`,
`modules/mod-09-document-management/test/backup-restore.test.ts` and
`platform/ps-11-customers/test/backup-restore.test.ts`.

Two things the script cannot do for you:

- **Get the snapshots off the host.** They sit on the same volume as the
  original, which survives a bad deploy but not a lost disk. Add an rsync or
  restic step to another machine — that is what makes this a backup.
- **Back up `.env`.** It holds the secrets, and a restored volume is useless
  with the wrong `SESSION_SECRET`.

## Upgrades

```sh
git pull
docker compose up -d --build
```

Each service applies its pending schema migrations on boot
(`server/migrations.ts`); migrations are append-only and idempotent, so
rolling a customer forward is pull + rebuild + restart.

## Smoke test (no Docker needed)

```sh
node deploy/smoke.mjs
```

Boots every service locally in production mode with generated secrets,
waits for every `/api/health`, and verifies the cross-service identity seam:
a PS-01 owner session (holds `platform:admin`) is accepted by PS-02, a member
session is rejected, and security headers are present. Use it to validate a
checkout before building images.

## Decommissioning a customer

Stop the stack and delete its volumes — all customer data lives there:

```sh
docker compose down -v
```
