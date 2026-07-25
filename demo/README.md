# 0815software Platform — Live Demo

**"A day at Acme Corporation"** — a single, runnable scenario that shows the
whole platform working as one integrated product, the way a customer would
actually use it.

It boots **8 Platform Services** and **4 business apps** as real processes, all
sharing one identity provider and one service credential, then drives a
complete **quote-to-cash-to-care** flow across them and narrates every
cross-service effect. Everything runs **offline** — mock/console adapters, no
vendor keys, no Docker.

```sh
node demo/scenario.mjs
```

## What it demonstrates

| Act | Story | Platform Services proven |
| --- | --- | --- |
| 1 | A salesperson signs into the **Offers** app | **PS-01 Identity** (SSO — the app has no password of its own; a wrong password is rejected by PS-01) |
| 2 | Acme quotes a customer, who accepts online | **PS-03** (offer email), **PS-07** (audit); the customer accepts through the **public link** with no login |
| 3 | Acme bills the accepted quote — one "finalize" click | **PS-10** (gapless number `RE-2026-0001`), **PS-06** (PDF archived), **PS-03** (customer emailed), **PS-07** (audit event) |
| 4 | The customer pays | **PS-08 Payments** (intent created, confirmed, settled on tick, posted to the ledger) |
| 5 | A support ticket comes in | **PS-04 AI** drafts the agent's reply; **PS-03** notifies; SSO again |
| 6 | A contract is filed in the **Documents** app | **PS-06** (stored) + **PS-09 Search** (indexed, then found by full-text search) |
| 7 | The platform proves itself | **PS-07** verifies the tamper-evident audit chain over **every** action from **all four** apps |

Four separate business apps — Offers (mod-13), Invoicing (mod-04), Support
(mod-12), Documents (mod-09) — none of which know about each other, all
coordinated through the shared platform. That is the whole pitch: **build apps
fast, and they compose.**

## How it works

- `scenario.mjs` spawns each service and module exactly as it runs in
  production (`tsx server/index.ts`), wiring them with environment variables:
  every module points at the same `IDENTITY_URL` (PS-01) and carries the same
  `PLATFORM_SERVICE_TOKEN`; each app is told the URLs of the services it uses
  (`NOTIFICATION_URL`, `PAYMENTS_URL`, …).
- The scenario then acts as the user: it drives the apps over their real HTTP
  APIs and, after each step, reads back from the **services** to prove the
  side-effect landed (the PDF is really in PS-06, the email is really queued in
  PS-03, the audit event is really on PS-07's chain).
- It asserts every outcome, so the demo doubles as an end-to-end integration
  test — if it prints `DEMO COMPLETE`, the whole platform genuinely works
  together.

The identity is the seeded **Acme Corporation** org; the human who logs in is
its owner (`owner@acme.test`), who holds the `platform:admin` permission the
apps require.

## From this demo to a customer pilot

This scenario is the scripted proof. To let a customer **click** the apps:

1. Bring up the platform stack with TLS via the reference deployment —
   see [`../deploy/README.md`](../deploy/README.md) (`docker compose up`).
2. Run each business module against it, pointing the same environment variables
   (`IDENTITY_URL`, `PLATFORM_SERVICE_TOKEN`, the per-service URLs) at the
   deployed services, and open its web UI.

The wiring the customer needs is exactly the environment map at the top of
`scenario.mjs` — it is the reference for how an app joins the platform.

## Note on realism

Adapters run in their offline/mock mode here (console email, the deterministic
mock PSP and mock AI), so the demo needs no secrets. Point the services at real
vendors — Stripe, Resend/Twilio, OpenAI/Anthropic — by setting their keys (see
each service's README and `npm run test:live`); the app-facing behavior is
identical.
