# PS-06 · File / Object Storage

Shared blob store for the 0815software platform. Modules that produce files —
invoice PDFs, product images, report exports, uploaded documents — put them
here through one API instead of each writing to its own disk and reinventing
checksums, metadata and signed links.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto only).

## What it is

- **Buckets** group objects; **objects** are addressed by `bucket` + `key`.
- **Content-addressed** — each object stores its `size` and SHA-256 `sha256`,
  plus a `content_type` and free-form string `metadata`.
- **Signed download URLs** — mint a short-lived HMAC-signed URL that serves
  the bytes **without a session**, so a module can hand a link straight to a
  browser. Tampered or expired links are rejected.
- **Self-contained storage** — object bytes live in SQLite as BLOBs by
  default (zero external services); a real deployment can swap in an
  S3-compatible backend behind the same API.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (object bytes as BLOBs)      |
| Crypto  | Node built-in SHA-256 + HMAC-SHA256 (URLs)  |
| Tests   | Vitest + Supertest (offline, deterministic) |

Runtime dependencies: `express`, `better-sqlite3`. Nothing else.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-06-file-storage
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4006
```

```sh
curl -s localhost:4006/api/health
# create a bucket + store an object (service token):
curl -s -X POST localhost:4006/api/buckets \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"name":"documents"}'
curl -s -X PUT localhost:4006/api/objects/documents/hello.txt \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d "{\"content_base64\":\"$(printf 'hi' | base64)\",\"content_type\":\"text/plain\"}"
# mint a signed download URL and fetch it (no auth needed):
curl -s -X POST localhost:4006/api/objects/documents/hello.txt/sign \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' -d '{"ttl_seconds":300}'
```

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `POST /api/login` · `POST /api/logout` | public | Admin session. |
| `GET /api/download?bucket=&key=&expires=&sig=` | signature | Public, signed object download. |
| `POST /api/buckets` · `GET /api/buckets` | caller | Create / list buckets. |
| `PUT /api/objects/:bucket/:key` | caller | Store (create/overwrite) an object. |
| `GET /api/objects/:bucket/:key` | caller | Fetch object bytes (base64) + metadata. |
| `GET /api/objects/:bucket/:key/meta` | caller | Object metadata only. |
| `POST /api/objects/:bucket/:key/sign` | caller | Mint a signed, time-limited download URL. |
| `DELETE /api/objects/:bucket/:key` | caller | Delete an object. |
| `GET /api/objects/:bucket` | caller | List objects in a bucket. |

A **caller** is the admin session or a module presenting `X-Service-Token`.

## Consumed by

Business Modules, over this API. File Storage depends on no Business Module.
Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to verify end-user
callers against PS-01's `POST /api/tokens/verify`; unset, the service runs
standalone on its own admin/service-token.

## Tests

```sh
npm test
```
