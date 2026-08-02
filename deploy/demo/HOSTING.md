# Hosting the demo

End-to-end: a fresh server to a public, clickable demo at
`https://demo.yourdomain.com`, linked from the marketing site. About 20
minutes, most of it waiting for the first build.

Nothing here is provider-specific except step 1. The demo needs a host with a
public IPv4, ports 80 and 443 reachable, and Docker — that is the whole list.

## What it will run

Fifteen containers: nine Platform Services, four business apps (Offers,
Invoicing, Support, Documents), the hub page, and Caddy. Only Caddy is exposed;
the services stay on the internal network. Databases live on **tmpfs**, so the
nightly reset wipes the shared demo clean and every app re-seeds.

**Size the host for the build, not the run.** Idle, the stack is modest; the
first `docker compose up --build` compiles four React UIs and twelve TypeScript
servers at once, which is the memory-hungry part. 4 vCPU / 8 GB builds it
comfortably. On 4 GB, build the apps one at a time (below). Reckon on ~10 GB of
disk for images and layers.

## 1. Create the server

### netcup

In the **Server Control Panel (SCP)**:

1. Order a VPS (a 4 vCPU / 8 GB tier is comfortable; ARM works too).
2. **Install an image:** *Debian 13* (minimal is fine — the setup script
   installs everything else).
3. Add your SSH key, or note the root password mailed to you.
4. netcup ships **no cloud firewall** in front of the VPS, so nothing has to be
   opened externally — but check the host itself:

   ```sh
   ufw status          # if it says "inactive", nothing is blocking
   ```

   If `ufw` is active, the setup script opens 80 and 443 for you.
5. Note the public **IPv4** from the SCP overview.

### Hetzner Cloud

*Add Server* → Nürnberg/Falkenstein, image **Debian 13** (or Ubuntu 24.04),
type **CX32** (4 vCPU / 8 GB), your SSH key, and attach a firewall allowing
inbound **TCP 22, 80, 443**.

<details><summary>With the <code>hcloud</code> CLI</summary>

```sh
hcloud firewall create --name demo-fw
hcloud firewall add-rule demo-fw --direction in --protocol tcp --port 22  --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule demo-fw --direction in --protocol tcp --port 80  --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule demo-fw --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0

hcloud server create --name 0815-demo --image debian-13 --type cx32 \
  --location nbg1 --ssh-key "$(hcloud ssh-key list -o noheader -o columns=name | head -1)" \
  --firewall demo-fw
```
</details>

### Anywhere else

Any VPS with a public IPv4 and 80/443 open works the same way. Skip to step 2.

## 2. Point DNS at it

A **wildcard** is easiest — one record covers the hub and all four apps:

| Type | Name | Value |
| --- | --- | --- |
| A | `demo.yourdomain.com` | `<server IPv4>` |
| A | `*.demo.yourdomain.com` | `<server IPv4>` |

Or four explicit records instead of the wildcard: `offers.`, `invoicing.`,
`support.`, `documents.` — plus the bare `demo.` for the hub.

Wait for them to resolve before step 3; Caddy issues certificates over HTTP-01
and needs the names pointing here already:

```sh
dig +short demo.yourdomain.com          # must print the server's IPv4
dig +short offers.demo.yourdomain.com   # same
```

## 3. Provision and launch

SSH in as root and run the setup script:

```sh
ssh root@<server IPv4>
curl -fsSL https://raw.githubusercontent.com/Gnadi/0815software/main/deploy/demo/setup.sh | bash
```

The **first run** installs Docker, clones the repo, and generates every secret
into `/opt/0815software/deploy/demo/.env`. It then stops and asks for the two
values only you know:

```sh
nano /opt/0815software/deploy/demo/.env
#   DEMO_DOMAIN=demo.yourdomain.com
#   ACME_EMAIL=ops@yourdomain.com
```

Run it **again** to build and start everything and install the nightly reset:

```sh
curl -fsSL https://raw.githubusercontent.com/Gnadi/0815software/main/deploy/demo/setup.sh | bash
```

<details><summary>Building on a smaller host (4 GB)</summary>

Build the four apps one at a time so the UI builds do not run concurrently:

```sh
cd /opt/0815software/deploy/demo
for app in offers invoicing support documents; do docker compose build "$app"; done
docker compose up -d --build
```
</details>

Once Caddy has issued certificates (a minute or two), open
**`https://demo.yourdomain.com`** — the hub, linking into every app.

Logins are shown on the hub: `owner@acme.test` / `demo-owner` (single sign-on,
for Offers/Invoicing/Support) and `admin` / `demo-admin` (Documents, which
keeps its own user model).

## 4. Show it on the marketing site

Set `PUBLIC_DEMO_URL=https://demo.yourdomain.com` in the Vercel project's
environment and redeploy. The `/demo` page's **"Launch the live demo"** button
then points straight at the hosted hub — the visitor just clicks. Without the
variable the page still works; it simply describes the apps instead of linking
to them.

## Operating it

- **Update to the latest code:** re-run the setup script — it pulls and rebuilds.
- **Reset the shared data now:** `cd /opt/0815software/deploy/demo && ./reset.sh`
  (a nightly cron at 04:00 already does this).
- **Watch it come up:** `docker compose ps` until everything is healthy.
- **Logs:** `docker compose logs -f caddy` for TLS and routing, or a service
  name for that container.

### When something is wrong

| Symptom | Where to look |
| --- | --- |
| Certificates never issue | Ports 80/443 reachable from outside? `dig +short demo.yourdomain.com` points here? `docker compose logs caddy` names the ACME failure. |
| A container restarts in a loop | `docker compose logs <name>`. In production mode every service refuses to start on a default secret — the message says which one, and the fix is a real value in `.env`. |
| An app 502s through Caddy | That app's container is not healthy yet; `docker compose ps` shows it. First boot after a build takes a few seconds per app. |
| The demo feels rate-limited | The stack sets `TRUST_PROXY=1` so limits are counted per visitor rather than per proxy. If you removed it, every visitor shares one bucket. |

## What this is not

This is the **demo** posture: shared data, resettable, mock adapters (console
email, mock payment provider, mock AI), no vendor keys. It is deliberately not
the per-customer production deployment — for that see
[`../README.md`](../README.md) and `deploy/provision.mjs`, which generates a
stack with persistent volumes, real secrets per customer, backups and
monitoring.
