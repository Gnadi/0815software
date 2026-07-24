# PS-07 · Audit Log

Tamper-evident, append-only activity trail for the 0815software platform.
Every module records *who did what to which resource* here instead of
scattering audit rows through its own database, and the log can be
cryptographically verified end to end.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto only).

## What it is

- **Append-only events** — `{actor, org, action, resource, before, after,
  metadata}` recorded with a service token, so any module can emit.
- **Hash-chained** — each event's SHA-256 `hash` covers its own content **and
  the previous event's hash**. The log is a chain: altering or deleting any
  past event breaks every hash after it.
- **Integrity verification** — `GET /api/verify` recomputes the whole chain
  and reports the first broken link, if any.
- **Filtered reads** — list by `actor`, `resource`, `action`, `org` or
  `since`, newest first, behind the admin/identity gate.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Crypto  | Node built-in SHA-256 (hash chain)          |
| Tests   | Vitest + Supertest (offline, deterministic) |

Runtime dependencies: `express`, `better-sqlite3`. Nothing else.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-07-audit-log
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4007
```

```sh
curl -s localhost:4007/api/health
# record an event (service token):
curl -s -X POST localhost:4007/api/events \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"actor":"user:1","org":"acme","action":"invoice.sent","resource":"invoice:INV-1"}'
# admin: verify chain integrity
TOKEN=$(curl -s -X POST localhost:4007/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me"}' | jq -r .token)
curl -s localhost:4007/api/verify -H "Authorization: Bearer $TOKEN"
```

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `POST /api/login` · `POST /api/logout` | public | Admin session. |
| `POST /api/events` | service token | Append an audit event to the chain. |
| `GET /api/events` | admin | List events (`?actor=&resource=&action=&org=&since=&limit=`). |
| `GET /api/verify` | admin | Recompute the chain → `{valid, count, broken_at?}`. |

## Consumed by

Business Modules, over this API. The Audit Log depends on no Business
Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to verify
end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```
