# Hosted Demo

The live, clickable demo — packaged to run on **one server** so customers reach
it from a URL, no clone or local setup. It boots the nine platform services and
the four business apps (Offers, Invoicing, Support, Documents), wired together,
behind Caddy with automatic TLS. Only Caddy is exposed; the services stay
internal.

This is the same wiring as [`demo/serve.mjs`](../../demo/README.md), packaged
for a host. For the hardened, per-customer *production* deployment, see
[`../README.md`](../README.md) — this one optimises for "just works as a public
demo" (shared, resettable data).

> **On Hetzner Cloud?** [`HETZNER.md`](./HETZNER.md) is a click-by-click
> runbook (create the server, DNS, one provisioning script) — start there.
> The steps below are the host-agnostic version.

## 1. Point DNS at the host

The hub lives on `DEMO_DOMAIN`; each app on a subdomain. A wildcard is easiest:

```
demo.example.com        A   <host IP>
*.demo.example.com      A   <host IP>
```

(or four explicit records: `offers.` `invoicing.` `support.` `documents.`)

## 2. Configure

```sh
cd deploy/demo
cp .env.example .env
# set DEMO_DOMAIN + ACME_EMAIL, and generate each secret with `openssl rand -hex 32`
```

## 3. Bring it up

```sh
docker compose up -d --build      # first build takes a few minutes
docker compose ps                 # all services become healthy
```

Caddy provisions certificates on first request (ports 80/443 must be open).
Then open **`https://<DEMO_DOMAIN>`** — the hub, linking into every app.

## Logins (shown on the hub)

- **Single sign-on** (Offers, Invoicing, Support): `owner@acme.test` /
  `demo-owner` — validated by PS-01 Identity.
- **Documents**: `admin` / `demo-admin` (its own matter-based user model).

## Resetting the shared demo

A public demo shares data across visitors. Databases are on **tmpfs**, so a
restart wipes them and every app re-seeds:

```sh
./reset.sh          # docker compose restart
```

Schedule it nightly from the host's cron:

```
0 4 * * *  cd /opt/0815-demo/deploy/demo && ./reset.sh >> reset.log 2>&1
```

## Show it on the marketing site

Once it's live, set `PUBLIC_DEMO_URL=https://<DEMO_DOMAIN>` in the marketing
site's environment (Vercel). The `/demo` page then shows a **"Launch the live
demo"** button straight to the hosted hub — the customer just clicks.

## How it's wired

- **Apps** run their compiled server (`node dist/server/server/index.js`), which
  serves the built React UI from `dist/client` and the API on one origin. Each
  is on its own subdomain so the SPA can call `/api/*` on its own origin.
- **SSO and service calls stay internal:** an app's server talks to PS-01 and
  the other services over the private `demo` network (`IDENTITY_URL`,
  `NOTIFICATION_URL`, `PAYMENTS_URL`, …) with a shared `PLATFORM_SERVICE_TOKEN`.
  The services are never exposed publicly.
- `module.Dockerfile` builds an app (it first builds the shared
  `@0815software/platform-clients` package the module links to); the platform
  services reuse `../Dockerfile`.

## Note on scope

Runs with the offline/mock adapters (console email, mock PSP, mock AI) — no
vendor keys. Point the services at real vendors by adding their keys (see each
service's README); the app-facing behaviour is identical.
