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
- **Enterprise SSO**: any OIDC provider is configured by name with an issuer —
  endpoints come from discovery, the code exchange is PKCE-protected, and the
  ID token is verified against the provider's JWKS.
- **SCIM 2.0** at `/scim/v2`: the customer's directory creates, updates and
  **de-provisions** accounts here, and a de-provision kills live sessions.
- **SAML 2.0** for the IdPs that do not speak OIDC — SP metadata, signed
  AuthnRequests, and an ACS that verifies the assertion before touching anything.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Crypto  | Node built-in `scrypt` + HMAC-SHA256        |
| Tests   | Vitest + Supertest                          |

Runtime dependencies: `express`, `better-sqlite3`, and — for SAML only —
`@node-saml/node-saml` (MIT), loaded lazily so a deployment with no SAML
provider never touches it. That third dependency is a deliberate exception to
this catalog's "no auth libraries" rule; [the reasoning is below](#saml-20-and-the-one-dependency)
and at the top of [`server/saml.ts`](./server/saml.ts).

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
| `POST /api/login` | `{org_slug,email,password}` → `{token,user}` + session cookie. Repeated failures against one account slow every further attempt down (no lockout — see `server/throttle.ts`). |
| `POST /api/logout` | Clear the session cookie. |
| `GET /api/oauth/:provider/authorize` | `?org_slug=` → records a CSRF state nonce (plus a PKCE verifier and an OIDC nonce), 302 to the provider (or the mock IdP). `?redirect_uri=` must be same-site or allowlisted. |
| `GET /api/oauth/:provider/callback` | Consumes the state (single-use, 10-minute TTL), exchanges the code with the PKCE verifier, **verifies the ID token**, provisions-or-links the user, issues a session. |

### Authenticated

| Method & path | Permission | Purpose |
| ------------- | ---------- | ------- |
| `GET /api/me` | any | Current identity, roles, permissions. |
| `POST /api/tokens/verify` | any | `{token}` → `{valid, claims?}` — **cross-service contract**. |
| `GET /api/permissions` | any | The permission catalog. |
| `POST /api/me/sessions/revoke` | any user | Invalidate all your sessions (bumps `token_version`); returns a fresh token for this caller. |
| `POST /api/users/:id/sessions/revoke` | `user:write` | Invalidate all of a user's sessions. |
| `GET /api/orgs` | `org:read` | The caller's organization. |
| `POST /api/orgs` | `org:write` | Provision an organization (`{slug,name,owner?:{email,name,password}}`). Without an `owner` nobody can log into it. |
| `GET /api/users` | `user:read` | List users in the caller's org. |
| `POST /api/users` | `user:write` | Create a user (`{email,name,password,role_keys?}`). |
| `GET /api/users/:id` | `user:read` | Fetch a user (foreign tenant → 404). |
| `PATCH /api/users/:id` | `user:write` | Update name/status. |
| `POST /api/users/:id/password` | `user:write` (other) or self | Set password (bumps `token_version`). Changing your **own** requires `current_password`. |
| `GET /api/roles` | `role:read` | System roles + org custom roles. |
| `POST /api/roles` | `role:write` | Create a custom role (`{key,name,permissions[]}`). |
| `POST /api/users/:id/roles` | `role:write` | Assign a role (`{role_id}`). |
| `DELETE /api/users/:id/roles/:roleId` | `role:write` | Unassign a role. |
| `GET /api/api-keys` | `apikey:read` | List keys (prefixes only). |
| `POST /api/api-keys` | `apikey:write` | Mint a key — secret returned **once**. |
| `DELETE /api/api-keys/:id` | `apikey:write` | Revoke a key. |

## Enterprise SSO

The three shipped providers (`google`, `microsoft`, `github`) are a
convenience, not the supported set. A customer arrives with Entra ID, Okta,
Keycloak or a public-sector IdP, and configuring one is environment only:

```sh
OAUTH_KEYCLOAK_ISSUER=https://sso.customer.example/realms/staff
OAUTH_KEYCLOAK_CLIENT_ID=ps01
OAUTH_KEYCLOAK_CLIENT_SECRET=...
```

That declares a provider called `keycloak`, served at
`/api/oauth/keycloak/authorize`. Every `OAUTH_<NAME>_CLIENT_ID` in the
environment declares a provider, so the name is yours to choose. The service
prints the ones it recognised on boot — worth reading, because a misspelled
variable declares nothing and would otherwise fail only at a user's first login.

**Discovery.** With an issuer set, the authorize, token, userinfo and JWKS
endpoints are read from `<issuer>/.well-known/openid-configuration` on first
use and cached for an hour. The document's own `issuer` must equal the
configured one — without that check a provider could hand back another issuer's
endpoints and the ID token would be validated against the wrong authority.
Any endpoint can be pinned explicitly (`OAUTH_<NAME>_TOKEN_URL=…`) and an
explicit value always wins over a discovered one.

**PKCE** (S256) is on by default. The verifier is stored here and travels only
on the back-channel token request, so an intercepted authorization code cannot
be redeemed by whoever intercepted it.

**ID token verification** (`server/oidc.ts`) is the part worth being precise
about, because everything downstream believes its answer:

| Checked | Why |
| ------- | --- |
| Signature against the provider's JWKS | The assertion is only worth what signed it. |
| `alg` against an explicit allowlist | `none` is forgery; `HS256` verified against a JWKS entry lets anyone who can read the public key sign a token we accept. Neither is in the table, so neither is reachable. |
| `iss`, `aud`, and `azp` when multi-audience | A token minted for a different client of the same IdP is a valid token — for somebody else. |
| `exp`, `iat`, `nbf` (±120s skew) | Replay of an old assertion. |
| `nonce`, in constant time | Binds the token to the authorize request this browser actually started. |

A provider that returns an `id_token` but publishes no JWKS is refused rather
than believed. Where both an ID token and `userinfo` exist, the ID token wins
and `userinfo` may only fill a gap — a `userinfo` response disagreeing about
`sub` is treated as a different person and refused.

Built on Node's `crypto` alone, like the rest of the service.

## SAML 2.0, and the one dependency

Prefer OIDC. Entra ID, Okta, Keycloak and Google Workspace all speak it, and
the OIDC path above needs nothing but Node's own crypto. SAML exists here for
the IdPs that do not offer OIDC — older enterprise deployments, and public
sector federations such as the Austrian PVP2 profile.

Configuration mirrors OIDC. Every `SAML_<NAME>_ENTRY_POINT` declares a provider:

```sh
SAML_ENTRA_ENTRY_POINT=https://login.microsoftonline.com/<tenant>/saml2
SAML_ENTRA_IDP_CERT=MIIC8DCCAdig...      # PEM or bare base64, | to list several
SAML_ENTRA_IDP_ISSUER=https://sts.windows.net/<tenant>/
```

Three endpoints follow: `GET /api/saml/entra/metadata` (the XML an
administrator uploads to the IdP), `GET /api/saml/entra/login?org_slug=…`, and
`POST /api/saml/entra/acs`.

### Why this one takes a dependency

The rest of this service verifies signatures on `node:crypto`, including JWS —
a JWS is three base64url segments and one signature check, which is a
reasonable thing to write.

XML Digital Signature is not. Verifying it means exclusive canonicalisation
with its namespace rules, digest checking, and defending against **signature
wrapping**: the attacker keeps the IdP's genuinely signed assertion somewhere
the verifier will still find a valid signature for it, and puts their own
unsigned assertion where the consumer reads the identity. That bug class has a
long CVE history in libraries maintained by people who do nothing else, and it
**fails open** — a wrong implementation does not error, it signs the attacker
in. `@node-saml/node-saml` is the maintained MIT implementation, and taking it
is the cheaper of the two risks.

The obvious objection is PS-12 Banking, which implements exclusive
canonicalisation and XML-DSig itself and takes nothing. The difference is the
direction of the operation. PS-12 **signs**, with its own key, over a document
it composed — no adversary chooses the input, and a bug produces a signature
the bank rejects, which fails closed and loudly against one counterparty. This
**verifies** a document an attacker writes in full, and a bug hands them a
session. Same standard, opposite risk.

`test/saml.test.ts` constructs that attack, in both element orderings, and
requires a refusal. The assertions in those cases are signed with a real key
against a committed test certificate rather than mocked, because a test that
mocks the signature check tests nothing that matters here.

### What is pinned rather than configurable

| Setting | Value | Why |
| ------- | ----- | --- |
| `wantAssertionsSigned` | always `true` | An unsigned assertion is not an assertion. No environment variable can turn this off. |
| `validateInResponseTo` | always | A Response must name an AuthnRequest we sent, and each id is spent on one Response — SAML's replay defence. |
| `audience` | our SP entity ID | An assertion addressed to somebody else is not addressed to us. |
| Signature algorithm | `sha256` or `sha512` | `sha1` is accepted by the library and by plenty of old IdPs. It is refused here at boot. |
| Clock skew | 120s | The same tolerance the OIDC path allows. |

`wantAuthnResponseSigned` is off by default and can be turned on
(`SAML_<NAME>_WANT_RESPONSE_SIGNED=true`); Entra ID and others sign only the
assertion, which is the signature that matters.

The AuthnRequest ids live in SQLite (`saml_request_ids`), not in the library's
in-memory cache. In memory they would be lost on restart, breaking every login
in flight — and the obvious workaround for that is to turn the InResponseTo
check off, which is the one thing that must not happen.

One check is made here rather than by the library: node-saml enforces its
`idpIssuer` option on logout messages only — `verifyIssuer` is never called on
an authentication Response (5.1.0, `lib/saml.js`). Configuring it and assuming
it applied would document a check that does not run, so `identityFromProfile`
compares the issuer of the signed assertion itself.

## SCIM 2.0 provisioning

OIDC answers *who is signing in*. It says nothing about the accounts that exist
before anybody signs in, and nothing about the ones that should stop existing —
which is the half an IT department actually asks for. `/scim/v2` is where the
customer's directory pushes that lifecycle.

Point the IdP at `https://identity.customer.example/scim/v2` with a PS-01 API
key as the bearer token. SCIM defines no credential of its own, so provisioning
reuses the ones this service already has: the key's organization does tenancy
and the key's scopes do authorization. Scope it to `org:read`, `user:read`,
`user:write`, `role:read`, `role:write` — a key scoped that way cannot mint
further keys, cannot touch an account holding permissions it does not itself
hold (so it cannot disable the Owner), and cannot provision one either.
`org:read` is in the list because the default `member` role grants it.

| Resource | Supported |
| -------- | --------- |
| `/Users` | `GET` (paged, `filter` on `userName`, `externalId`, `emails.value`, `id`), `POST`, `GET/:id`, `PUT/:id`, `PATCH/:id`, `DELETE/:id` |
| `/Groups` | `GET`, `GET/:id`, `PATCH/:id` (membership only) — groups are PS-01 roles |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | The discovery documents Entra ID and Okta fetch first |

Three decisions the implementation makes deliberately:

1. **Nothing is hard-deleted.** A SCIM `DELETE` deactivates. A directory that
   de-provisions by accident — a mis-scoped group, a bad sync — would otherwise
   be unrecoverable, and the audit trail would go with the row.
2. **Deactivation revokes sessions immediately.** Marking a user inactive bumps
   `token_version`, so tokens they already hold die on the next request. Without
   that, de-provisioning only prevents the *next* login and the person walking
   out of the building keeps a working session — which is the exact thing the
   feature is bought for.
3. **Groups cannot be created or deleted through SCIM.** A role here carries
   permissions; letting a directory sync invent one would let whoever
   administers the IdP mint authority inside this service. Membership in a role
   an operator already defined is the whole of what provisioning needs.

Filters are restricted on purpose: only `attribute eq "value"`, the one shape
provisioning clients actually send. Half-supporting the full grammar is how a
de-provisioning client gets "everything" back from a filter it thought was
narrow.

## Consumed by

Business Modules, over this API. Identity depends on no Business Module.
See [`.env.example`](./.env.example) for the (commented-out) `IDENTITY_URL`
seam other Platform Services would use to verify tokens against PS-01 in a
real deployment.

## Tests

```sh
npm test            # the suite
npm run test:coverage   # the suite, with the coverage gate
```

Covers unknown-account login timing, tenant isolation (cross-org → 404),
RBAC (member forbidden / admin allowed), password-change token revocation,
API-key mint + revoke, and the `tokens/verify` round-trip.

`test/oidc.test.ts` generates real RSA and EC keypairs and signs real tokens, so
the verification cases are the actual attacks rather than assertions about
strings: `alg: none`, an HS256 token signed with the provider's own public key,
a token minted for another client, a replayed nonce, a rotated `kid`. Each one
must be refused, and the test fails if it is not.

`test/scim.test.ts` drives the provisioning surface the way Entra ID and Okta
drive it, including the shapes that are easy to get wrong — a capitalised
`Replace` verb, `active` sent as the **string** `"False"`, membership sent as
bare id strings. Its most important case is the one that signs a user in and
then de-provisions them, asserting the live token stops working.

`test/saml.test.ts` runs a real IdP: it builds SAML Responses and signs them
with `xml-crypto` against the committed test certificate in `test/fixtures/`
(see the README there — that key is public and is for this test only). The case
worth reading is the signature-wrapping one, which is the reason this service
takes a dependency for SAML and not for OIDC.

**Coverage is a gate, not a report.** `vitest.config.ts` fails the run below
90% on statements, branches, functions and lines; the suite currently sits near
99%. This service is the one every other package authenticates through —
PS-02…12 all call `POST /api/tokens/verify`, and the thirteen SSO modules
delegate their login here — so a defect in it is a defect everywhere, and
successive reviews kept finding one in the branches nobody had executed.

Two things are tested as real processes rather than in-process, because that is
the only honest way to test them: `test/boot.test.ts` spawns `server/index.ts`
and asserts that the production boot guard actually refuses a default or blank
secret, that a good configuration serves and carries its security headers, and
that `npm run seed` provisions a database once and is a no-op the second time.
v8 cannot instrument a child process, so `server/index.ts` is excluded from the
coverage denominator — it is covered by those cases, just not countably.

## API contract

The full endpoint + auth surface is documented in [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1). Request/response *shapes* are typed in
[`@0815software/platform-clients`](../clients) and pinned by `test/contract.test.ts`,
which boots this service and drives the real client over HTTP — so the client and
the service cannot drift apart unnoticed.
