# Reference Deployment

One full platform stack for **one customer** — see
[`docs/DEPLOYMENT-MODEL.md`](../docs/DEPLOYMENT-MODEL.md) for the tenancy
stance. The stack is: PS-01…10 as containers, Caddy for TLS + routing, a
ticker sidecar driving the queue services, and per-service volumes for
databases and backups.

## Bring-up

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
