# PS-01 · Identity

Shared authentication and authorization service for the 0815software
platform. Every Business Module delegates *who is this* and *what may they
do* to Identity instead of shipping its own auth stack.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto
only — no auth libraries).

## What it is

A single authority for identity and access across all modules: one login,
one set of users and roles, strict multi-tenant isolation. It issues
stateless HMAC session tokens and API keys, and exposes
`POST /api/tokens/verify` as the contract other services use to check a
caller's identity.

- **Passwords** are hashed with Node's `crypto.scrypt` (`scrypt:<salt>:<key>`);
  unknown-account logins burn equal work so timing never leaks existence.
- **Sessions** are stateless tokens `<userId>.<orgId>.<tokenVersion>.<expiry>.<hmac>`;
  a password change bumps `token_version`, instantly revoking every prior
  token.
- **API keys** (`psk_<prefix>.<secret>`) authenticate machines; only a
  scrypt hash of the secret half is stored and the full key is shown once.
- **Multi-tenancy**: every authenticated query is scoped to the caller's
  organization; a resource in another tenant returns **404**, never 403.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Crypto  | Node built-in `scrypt` + HMAC-SHA256        |
| Tests   | Vitest + Supertest                          |

Runtime dependencies: `express`, `better-sqlite3`. Nothing else.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-01-identity
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4001
```

Seeded demo tenants (two orgs, to demonstrate isolation):

| Org      | Email               | Password      | Role   |
| -------- | ------------------- | ------------- | ------ |
| `acme`   | `owner@acme.test`   | `demo-owner`  | owner  |
| `acme`   | `admin@acme.test`   | `demo-admin`  | admin  |
| `acme`   | `member@acme.test`  | `demo-member` | member |
| `globex` | `owner@globex.test` | `demo-owner`  | owner  |

```sh
curl -s localhost:4001/api/health
curl -s -X POST localhost:4001/api/login \
  -H 'Content-Type: application/json' \
  -d '{"org_slug":"acme","email":"owner@acme.test","password":"demo-owner"}'
```

Production build: `npm run build && npm start`.

## API

Authenticate with the session cookie, a `Authorization: Bearer <session-token>`,
or a `Authorization: Bearer psk_...` API key. All errors are
`{ error, details? }` with status **422** (validation) · **401** (no
session) · **403** (insufficient permission) · **404** (not-found /
foreign tenant) · **409** (conflict).

### Public

| Method & path | Purpose |
| ------------- | ------- |
| `GET /api/health` | Liveness. |
| `POST /api/login` | `{org_slug,email,password}` → `{token,user}` + session cookie. |
| `POST /api/logout` | Clear the session cookie. |
| `GET /api/oauth/:provider/authorize` | `?org_slug=` → records a CSRF state nonce, 302 to the provider (or the mock IdP). |
| `GET /api/oauth/:provider/callback` | Consumes the state, resolves the identity, provisions-or-links the user, issues a session. |

### Authenticated

| Method & path | Permission | Purpose |
| ------------- | ---------- | ------- |
| `GET /api/me` | any | Current identity, roles, permissions. |
| `POST /api/tokens/verify` | any | `{token}` → `{valid, claims?}` — **cross-service contract**. |
| `GET /api/permissions` | any | The permission catalog. |
| `GET /api/orgs` | `org:read` | The caller's organization. |
| `POST /api/orgs` | `org:write` | Provision a new organization. |
| `GET /api/users` | `user:read` | List users in the caller's org. |
| `POST /api/users` | `user:write` | Create a user (`{email,name,password,role_keys?}`). |
| `GET /api/users/:id` | `user:read` | Fetch a user (foreign tenant → 404). |
| `PATCH /api/users/:id` | `user:write` | Update name/status. |
| `POST /api/users/:id/password` | `user:write` or self | Reset password (bumps `token_version`). |
| `GET /api/roles` | `role:read` | System roles + org custom roles. |
| `POST /api/roles` | `role:write` | Create a custom role (`{key,name,permissions[]}`). |
| `POST /api/users/:id/roles` | `role:write` | Assign a role (`{role_id}`). |
| `DELETE /api/users/:id/roles/:roleId` | `role:write` | Unassign a role. |
| `GET /api/api-keys` | `apikey:read` | List keys (prefixes only). |
| `POST /api/api-keys` | `apikey:write` | Mint a key — secret returned **once**. |
| `DELETE /api/api-keys/:id` | `apikey:write` | Revoke a key. |

## Consumed by

Business Modules, over this API. Identity depends on no Business Module.
See [`.env.example`](./.env.example) for the (commented-out) `IDENTITY_URL`
seam other Platform Services would use to verify tokens against PS-01 in a
real deployment.

## Tests

```sh
npm test
```

Covers unknown-account login timing, tenant isolation (cross-org → 404),
RBAC (member forbidden / admin allowed), password-change token revocation,
API-key mint + revoke, and the `tokens/verify` round-trip.
