# Hosting the demo on Hetzner Cloud

End-to-end: a fresh Hetzner server to a public, clickable demo at
`https://demo.yourdomain.com`. ~15 minutes, ~€7/month.

## 1. Create the server

**Hetzner Cloud Console → Add Server:**

- **Location:** Nürnberg or Falkenstein (DACH).
- **Image:** Ubuntu 24.04.
- **Type:** **CX32** (4 vCPU / 8 GB) — recommended, the first build compiles
  twelve images. **CAX31** (Arm, cheaper) also works. A CX22 (4 GB) works too
  but build one-at-a-time if memory is tight.
- **SSH key:** add yours.
- **Firewall:** attach one allowing inbound **TCP 22, 80, 443** (create under
  *Firewalls* first, or add afterwards).

<details><summary>Or with the <code>hcloud</code> CLI</summary>

```sh
hcloud firewall create --name demo-fw
hcloud firewall add-rule demo-fw --direction in --protocol tcp --port 22  --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule demo-fw --direction in --protocol tcp --port 80  --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule demo-fw --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0

hcloud server create --name 0815-demo --image ubuntu-24.04 --type cx32 \
  --location nbg1 --ssh-key "$(hcloud ssh-key list -o noheader -o columns=name | head -1)" \
  --firewall demo-fw
```
</details>

Note the server's **public IPv4**.

## 2. Point DNS at it

A **wildcard** is easiest — one record covers the hub and all four apps:

| Type | Name | Value |
| --- | --- | --- |
| A | `demo.yourdomain.com` | `<server IPv4>` |
| A | `*.demo.yourdomain.com` | `<server IPv4>` |

If your DNS is at Hetzner (*DNS Console*), add the zone and these two records.
At another registrar, add the same two A records there.

## 3. Provision and launch

SSH in as root and run the setup script:

```sh
ssh root@<server IPv4>
curl -fsSL https://raw.githubusercontent.com/Gnadi/0815software/main/deploy/demo/setup-hetzner.sh | bash
```

On the **first run** it installs Docker, clones the repo, and generates all
secrets into `/opt/0815software/deploy/demo/.env`. Then set your domain:

```sh
nano /opt/0815software/deploy/demo/.env
#   DEMO_DOMAIN=demo.yourdomain.com
#   ACME_EMAIL=ops@yourdomain.com
```

Run the script **again** to build and start everything (and install the nightly
reset cron):

```sh
curl -fsSL https://raw.githubusercontent.com/Gnadi/0815software/main/deploy/demo/setup-hetzner.sh | bash
```

Once DNS has propagated and Caddy has issued certificates (a minute or two),
open **`https://demo.yourdomain.com`** — the hub, linking into every app.

Logins are shown on the hub: `owner@acme.test` / `demo-owner` (SSO) and
`admin` / `demo-admin` (Documents).

## 4. Show it on the marketing site

Set `PUBLIC_DEMO_URL=https://demo.yourdomain.com` in the Vercel project's
environment and redeploy. The `/demo` page's **"Launch the live demo"** button
then points straight at the hosted hub — the customer just clicks.

## Operating it

- **Update to the latest code:** re-run the setup script (it pulls + rebuilds).
- **Reset the shared data now:** `cd /opt/0815software/deploy/demo && ./reset.sh`
  (a nightly cron at 04:00 already does this).
- **Logs:** `docker compose logs -f caddy` (TLS/routing), or a service name.
- **Certificates not issuing?** Check the firewall allows 80/443 and that
  `demo.` and `*.demo.` resolve to the server (`dig +short demo.yourdomain.com`).

See [`README.md`](./README.md) for what the stack contains and how it's wired.
