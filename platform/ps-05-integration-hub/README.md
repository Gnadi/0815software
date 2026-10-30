# PS-05 · Integration Hub

Centralized third-party integration service for the 0815software platform.
One place to manage OAuth-style connections and adapters to external SaaS,
so modules consume a normalized API instead of maintaining vendor clients
themselves.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto
only).

## What it is

- **Connections** store per-provider credentials **encrypted at rest**
  (AES-256-GCM). The plaintext is never written and never returned — every
  read is redacted.
- **Provider registry** (`google`, `microsoft`, `stripe`, `github`,
  `shopify`, `rest`, `graphql`) is config-as-code: base URL, outbound auth
  type, and inbound signature scheme, validated at boot.
- **Generic proxy** issues REST or GraphQL calls through a connection,
  decrypting the credentials and injecting the correct auth header — so a
  module never handles the secret itself. Every outbound call — the proxy and
  the OAuth token exchange alike — is checked first: a target resolving into
  private address space is refused with 403, so a connection cannot be aimed
  at the rest of the stack (`EGRESS_ALLOW_HOSTS` lists the exceptions).
- **Inbound webhooks** are verified per provider (GitHub / Stripe / Shopify
  HMAC schemes) and recorded with their `signature_valid` verdict.
- **OAuth connect** (authorize/callback), **token refresh** and **sync jobs**
  all work: a real provider token exchange runs when that provider is
  configured, otherwise a deterministic offline mock completes the flow.
  Sync jobs advance `pending → done` on `POST /api/tick` via a pluggable
  per-provider adapter (mock by default).

## Mailboxes (provider `imap`)

A connection can be a mailbox: `POST /api/connections` with
`{ provider: "imap", name, credentials: { host, port?, security?, username,
password, mailbox? } }`. `security` is `tls` (port 993, the default) or
`starttls` (143) — there is no plaintext option, because the password would
travel in the clear. The credentials are validated on creation (a mailbox that
could never be opened is refused then, not at the first fetch) and stored
encrypted like every other connection's. The host goes through the same egress
check as the proxy, and the socket is opened to exactly the address the check
approved — so, unlike `fetch`, a DNS answer that changes in between cannot
redirect it.

| Route | What it does |
| --- | --- |
| `POST /api/connections/:id/mail/probe` | Log in, select the folder, count what is unread — the "test connection" button. |
| `POST /api/connections/:id/mail/fetch` `{ limit? }` | The oldest unread messages (default 20, at most 100), **parsed**: sender, subject, threading ids, readable text, attachments (base64), and `automated` — why it looks machine-sent (RFC 3834 auto-reply, bounce, mailing list), or null. **Nothing is marked read.** |
| `POST /api/connections/:id/mail/ack` `{ uidvalidity, uids }` | Mark messages read once the consumer stored them. UIDs mean something only within one UIDVALIDITY; if the folder was rebuilt since the fetch, nothing is marked and the answer is **409**. |

Read and acknowledge are separate on purpose: should anything fail between
the two, the message is still unread and comes back — and the consumer
recognises it by its `message_id`. Nothing is lost and nothing is taken twice.

These three routes, and the redacted `GET /api/connections?provider=imap`
list, also accept the platform **service token** (`X-Service-Token`): a module
reads its mailbox as a machine. Creating, revoking and proxying stay an
administrator's.

Limits: a message over `MAIL_MAX_MESSAGE_BYTES` (10 MiB) comes as headers only
(`body_omitted: true`); one fetch carries at most `MAIL_MAX_FETCH_BYTES`
(25 MiB) and leaves the rest for the next (`remaining`); the mail server gets
`MAIL_TIMEOUT_SECONDS` (30) to answer. A refused login or an unreachable
server is **502** and recorded on the connection's events — what failed,
never a password or a message.

The parser (`server/mime.ts`) covers RFC 5322 headers, MIME multipart
(RFC 2045/2046), encoded words (RFC 2047) and parameters (RFC 2231), quoted-
printable and base64, and charsets including windows-1252. It is tested
against the RFCs' own examples (`test/mime.test.ts`); the IMAP client
(`server/imap.ts`, RFC 3501) against a local server over real TLS and STARTTLS
(`test/mailbox.test.ts`). It does not render HTML, verify signatures or
decrypt: a signed message's signature is one more attachment.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Crypto  | AES-256-GCM (credentials) + HMAC-SHA256 (webhooks) |
| Tests   | Vitest + Supertest (injected fetch)         |

Runtime dependencies: `express`, `better-sqlite3`. Outbound calls use the
built-in `fetch`.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-05-integration-hub
npm install
# a real 32-byte key is required in production; the dev default is all-zero:
export INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 32)
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4005
```

```sh
curl -s localhost:4005/api/health
TOKEN=$(curl -s -X POST localhost:4005/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me"}' | jq -r .token)
curl -s localhost:4005/api/connections -H "Authorization: Bearer $TOKEN"
```

The server refuses to start if `INTEGRATION_ENCRYPTION_KEY` is not exactly
64 hex characters. Production build: `npm run build && npm start`.

## API

Admin routes need a session (`POST /api/login`); the inbound webhook
receiver is public but signature-verified. Errors are `{ error, details? }`.

### Public

| Method & path | Purpose |
| ------------- | ------- |
| `GET /api/health` | Liveness. |
| `POST /api/login` · `POST /api/logout` | Admin session. |
| `POST /api/webhooks/:provider` | Inbound receiver — 401 missing / 403 bad / 202 verified. |

### Admin

| Method & path | Purpose |
| ------------- | ------- |
| `GET /api/providers` | The provider registry. |
| `GET/POST /api/connections`, `GET /api/connections/:id` | List / create / fetch (credentials redacted). |
| `DELETE /api/connections/:id` · `POST /api/connections/:id/refresh` | Revoke / refresh the connection's token. |
| `GET /api/connections/:provider/authorize` · `/callback` | OAuth connect flow (real when configured, mock otherwise). |
| `POST /api/connections/:id/proxy` · `/graphql` | Generic REST / GraphQL proxy with injected auth. |
| `GET /api/webhook-events`, `GET /api/webhook-events/:id` | Inbound webhook log. |
| `POST /api/connections/:id/sync` · `GET /api/sync-jobs` · `POST /api/tick` | Enqueue and drive outbound sync jobs. |

## Consumed by

Business Modules, over this API — MOD-12 reads its support mailbox through
the mail routes. The Integration Hub depends on no Business Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to verify
end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```

Covers fail-fast key validation, credentials encrypted at rest (no
plaintext ever returned or stored), inbound webhook signature verification
(401/403/202, verdict recorded), and the proxy injecting the correct auth
header + shaping REST and GraphQL requests (against a mocked `fetch`).

## API contract

The full endpoint + auth surface is documented in [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1). Request/response *shapes* are typed in
[`@0815software/platform-clients`](../clients) and pinned by `test/contract.test.ts`,
which boots this service and drives the real client over HTTP — so the client and
the service cannot drift apart unnoticed.
