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
  All ten services, no modules, hand-maintained. It is the shape a generated
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
reference (the two above need six, not ten), and writes `docker-compose.yml`,
`.env`, `Caddyfile`, `README.md` and `manifest.json`. Every secret is generated
fresh with `crypto.randomBytes(32)`, so no two customers share one and none is
a repo default. Values only the customer can supply — the seller VAT id, the
ACME contact — are written as `FILL-ME-IN` and listed in the summary.

Each module gets a subdomain (`invoicing.<domain>`, `offers.<domain>`); the
Platform Services keep their subpath routes on the bare domain. The ticker
sidecar is included only when the stack contains a tick-driven service.

Useful flags: `--all-services` (include all ten regardless of the selection),
`--source-db <module-id>` (required when a selected module reports on another
module's database, i.e. MOD-08), `--org` (PS-01 organization slug, defaults to
the customer), `--acme-email`, `--force` (overwrite a non-empty `--out`),
`--help`.

Run `node deploy/provision.mjs --help` for the full list and the module ids.

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
`/payments` → PS-08, `/search` → PS-09, `/number` → PS-10.

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

## Backups

```sh
./backup.sh        # snapshots every service DB onto its own volume
```

Schedule it from the host's cron (e.g. `0 2 * * *`). Each snapshot is an
online-consistent copy (`scripts/backup.mjs` in every image, via
better-sqlite3's backup API) written to `/data/backups` on the service's
volume. **Restore** = stop the service, replace `/data/data.db` with a
snapshot, start; pending schema migrations apply on boot.

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

Boots all ten services locally in production mode with generated secrets,
waits for every `/api/health`, and verifies the cross-service identity seam:
a PS-01 owner session (holds `platform:admin`) is accepted by PS-02, a member
session is rejected, and security headers are present. Use it to validate a
checkout before building images.

## Decommissioning a customer

Stop the stack and delete its volumes — all customer data lives there:

```sh
docker compose down -v
```
