# 0815software Platform — Live Demo

A **real, clickable** demo: four independent business apps, each with its own
web UI, all running against one shared platform — plus **Workspace**, a board
that puts them on one screen. Log into one and you're logged into all of them;
an action in one lights up services the others also use.

```sh
npm run demo         # from the demo/ directory  (node serve.mjs)
# → open http://localhost:4400
```

That boots **9 Platform Services** and **7 business-app UIs**, wires them
together, and serves a **hub page** that links you into each running app with
the demo logins. Everything runs **offline** — mock/console adapters, no vendor
keys, no Docker. The first run builds each app's UI (a few seconds each);
later runs skip straight to boot.

## The apps (and what each proves)

| App | Open | Story | Platform services it uses |
| --- | --- | --- | --- |
| **Workspace** | `:4415` | One board over the other six — start here | Identity, Audit, Customers |
| **CRM** | `:4410` | Deals in a pipeline; each one can become a quote | Audit, Customers |
| **Offers** | `:4413` | Quote a customer; they accept online via a public link | Notifications, Audit |
| **Invoicing** | `:4404` | Bill the accepted quote — one "finalize" click | **Numbering, Files, Notifications, Payments, Audit** |
| **Time** | `:4411` | Hours against projects, planned from accepted quotes | Audit |
| **Support** | `:4412` | Tickets with an AI-drafted reply | AI, Notifications, Audit |
| **Documents** | `:4409` | File a contract, find it by full-text search | Files, Search, Audit |

Between them they exercise **9 of the 11 platform services**. Each app is a
separate product (its own React UI, its own database) — the only thing they
share is the platform. **Workspace** is the exception that proves it: it holds
no business data at all, only board layouts, and every figure it shows is
fetched live from the app that owns it.

## The logins

- **Single sign-on** (Workspace, CRM, Offers, Invoicing, Time, Support): `owner@acme.test` /
  `demo-owner` — validated by **PS-01 Identity**. The apps have no password of
  their own; a wrong password is rejected by PS-01.
- **Documents**: `admin` / `demo-admin` — it keeps its own matter-based user
  model for now (SSO for these domain-user apps is on the roadmap), while still
  using the platform for storage, search, and audit.

## What Workspace shows you

- **Live widgets** from each app — add them with `ADD WIDGET`, drag and resize
  them. Nothing is cached; every number was computed just now by its owner.
- **One customer filter.** Pick a customer in the top bar and every widget
  narrows to them, matched on one PS-11 party id rather than a name. An app
  that cannot honour the filter says so instead of pretending.
- **The apps embedded.** Open Offers or Invoicing full-screen inside the board
  — already signed in, because the app issues its own session from a
  single-use ticket. Documents is deliberately *not* embeddable: its users are
  matter users, not staff, so the shell has no identity to assert there.
- **Cross-module actions.** An accepted quote carries a **BILL THIS** button
  that creates the draft invoice in Invoicing without opening either app — by
  calling Invoicing's *own* import route as you, so its history names you and
  not a service account.
- **One activity feed**, read from PS-07 as the person looking at it.

## A path worth clicking

0. **Workspace** — add widgets from Offers and Invoicing, then pick a customer
   and watch both narrow.
1. **Offers** — draft a quote, send it, open the customer's public link and
   accept it.
2. **Invoicing** — bill it. One "finalize" click assigns a gapless number from
   **PS-10**, archives the PDF in **PS-06**, emails the customer via **PS-03**,
   and records an event on **PS-07**'s tamper-evident audit chain. Then collect
   payment through **PS-08**.
3. **Support** — open a ticket and ask the AI (**PS-04**) for a draft reply.
4. **Documents** — file a contract (**PS-06**) and find it by search (**PS-09**).
5. Back in **Workspace** — walk the whole sales chain without opening an app:
   **QUOTE THIS** on a CRM deal makes a draft quote, **BILL THIS** on an
   accepted one makes the draft invoice, and **PLAN WORK** makes the project to
   book hours against. Each runs as you, in the target app's own history.

Every one of those actions, across every app, lands on the **same audit
chain** — one trail for the whole business.

## How it's wired

`serve.mjs` boots each service and app as a real process. Modules run their
**compiled** server (`node dist/server/server/index.js`), which serves the built
React UI from `dist/client` and the API from the same origin. Wiring is by
environment variable: every app points at the same `IDENTITY_URL` (PS-01),
carries the same `PLATFORM_SERVICE_TOKEN`, and is told the URLs of the services
it uses (`NOTIFICATION_URL`, `PAYMENTS_URL`, `NUMBER_URL`, …). That env map — at
the top of `serve.mjs` — is exactly how an app joins the platform.

## Also here: an automated end-to-end proof

`npm run e2e` (`scenario.mjs`) drives the same wired stack headlessly and
narrates every cross-service effect, asserting each outcome. It's the demo as a
pass/fail integration test — handy for CI or a quick "does it all still work"
check.

## From this demo to a customer pilot

The apps here run behind plain HTTP for local clicking. To host a pilot with
TLS, bring the platform up via the reference deployment
([`../deploy/README.md`](../deploy/README.md)) and run each app against it with
the same environment variables pointed at the deployed service URLs.

## Note on realism

Adapters run in offline/mock mode (console email, the deterministic mock PSP
and mock AI), so no secrets are needed. Point the services at real vendors —
Stripe, Resend/Twilio, OpenAI/Anthropic — by setting their keys (see each
service's README); the app-facing behavior is identical.
