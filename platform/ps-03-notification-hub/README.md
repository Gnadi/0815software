# PS-03 · Notification Hub

Centralized notification service for the 0815software platform. One place
to compose, template, queue and deliver messages across every channel, so
no module has to integrate a mail provider or push service directly.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto
only).

## What it is

- **Channels** (`email`, `sms`, `push`, `slack`, `teams`, `discord`,
  `webhook`) each point at a **provider**. The default `console` provider
  is a no-op that "delivers" without any external call. Real single-`fetch`
  adapters (no SDKs) ship for email (`resend-email`), SMS (`twilio-sms`),
  chat (`slack` / `teams` / `discord` incoming webhooks) and generic
  `webhook`.
- **Graceful degradation**: a channel whose real provider is not configured
  (an email channel with no `RESEND_API_KEY`, an SMS channel with no Twilio
  credentials, a chat channel with no webhook url) automatically falls back
  to the console provider, so a send still succeeds — mirroring the
  marketing site's contact form.
- **Templates** are versioned, with `{{variable}}` interpolation. Values
  are HTML-escaped for markup channels; a missing variable is a 422.
- **Messages** are a retryable queue: each is rendered at enqueue, then
  delivered on `POST /api/tick` with an exponential backoff schedule and
  dead-lettering after `MAX_ATTEMPTS`. Idempotency keys dedupe sends.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Tests   | Vitest + Supertest (injected clock + fetch) |

Runtime dependencies: `express`, `better-sqlite3`. The Resend and webhook
providers use the built-in `fetch`.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-03-notification-hub
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4003
```

```sh
curl -s localhost:4003/api/health
# submit a message (service token):
curl -s -X POST localhost:4003/api/send \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"channel":"transactional-email","to":"a@b.c","template_key":"welcome-email","variables":{"name":"Ada","org":"Acme"}}'
# admin: flush the queue
TOKEN=$(curl -s -X POST localhost:4003/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me"}' | jq -r .token)
curl -s -X POST localhost:4003/api/tick -H "Authorization: Bearer $TOKEN"
```

Set `RESEND_API_KEY` to send real email; otherwise email degrades to
console. Production build: `npm run build && npm start`.

## API

Admin routes need a session (`POST /api/login`); `POST /api/send` uses the
shared `SERVICE_TOKEN`. Errors are `{ error, details? }`.

### Public / service-token

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | none | Liveness. |
| `POST /api/login` · `POST /api/logout` | none | Admin session. |
| `POST /api/send` | `X-Service-Token` | Enqueue a message (raw or from a template). |

### Admin

| Method & path | Purpose |
| ------------- | ------- |
| `GET/POST /api/channels`, `PATCH /api/channels/:id` | Channel admin. |
| `GET/POST /api/templates`, `GET /api/templates/:key` | Versioned templates. |
| `POST /api/templates/:key/versions` | Append a version. |
| `POST /api/templates/:key/preview` | Render without sending. |
| `GET /api/messages`, `GET /api/messages/:id` | Queue view + event history. |
| `POST /api/messages/:id/retry` | Requeue a failed/dead message. |
| `POST /api/tick` | Flush the delivery queue once. |

## Consumed by

Business Modules, over this API. The Notification Hub depends on no
Business Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to
verify end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```

Covers template interpolation + HTML escaping + missing-variable 422 +
preview, console-provider send with no network call, idempotent sends,
template rendering on send, failing-provider backoff → dead-letter →
retry, and graceful degradation of an unconfigured email channel.
