# PS-09 · Search

Cross-entity keyword and faceted search for the 0815software platform. Modules
index their records (products, documents, contacts, tickets…) and query them
with filters through one API, instead of each hand-rolling `LIKE` queries.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto only).

## What it is

- **Full-text search** backed by **SQLite FTS5** (bundled with better-sqlite3
  — no external search engine), ranked by BM25, with prefix matching.
- **Collections** namespace documents by type; **tenant** scopes them for
  multi-tenant deployments.
- **Facets** — arbitrary `key: value` attributes stored per document, used to
  **filter** results (`facet.<key>=<value>`) and returned as **facet counts**
  over the matching set.
- **Upsert** semantics — re-indexing a `(collection, id)` replaces the previous
  document. Deterministic and offline; complements PS-04's semantic RAG rather
  than duplicating it (this is lexical/keyword search).

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 + FTS5 (single file)         |
| Tests   | Vitest + Supertest (offline, deterministic) |

Runtime dependencies: `express`, `better-sqlite3`. Nothing else.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-09-search
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4009
```

```sh
curl -s localhost:4009/api/health
# index a document (service token):
curl -s -X POST localhost:4009/api/index \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"collection":"products","id":"1","title":"Blue Widget","body":"sturdy blue widget","facets":{"color":"blue"}}'
# search with a facet filter:
curl -s 'localhost:4009/api/search?collection=products&q=widget&facet.color=blue' \
  -H 'X-Service-Token: dev-service-token'
```

## API

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | public | Liveness. |
| `POST /api/login` · `POST /api/logout` | public | Admin session. |
| `POST /api/index` | caller | Upsert a document `{collection, id, title, body?, facets?, tenant?}`. |
| `DELETE /api/index/:collection/:id` | caller | Remove a document (`?tenant=`). |
| `GET /api/search` | caller | `?collection=&q=&facet.k=v&tenant=&limit=&offset=` → `{total, hits, facets}`. |

A **caller** is the admin session or a module presenting `X-Service-Token`.

## Consumed by

Business Modules, over this API — e.g. Inventory, CRM, Document Management,
Support Tickets index their entities and search across them. Search depends on
no Business Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to
verify end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```
