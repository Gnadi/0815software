# PS-04 · AI Platform

Shared AI capabilities for the 0815software platform. Modules call one API
for chat, embeddings, retrieval and prompt management rather than each
wiring up its own model providers and prompt plumbing.

Part of the [Platform Services catalog](../README.md). Backend service,
MIT-licensed, self-contained (Express 5 + SQLite, Node built-in crypto
only).

## What it is

- **Provider abstraction** with a deterministic, built-in **mock** provider
  as the default — zero external calls, so chat, embeddings and RAG are
  reproducible offline and in CI. Real vendor adapters (a single `fetch`
  each, no SDKs) activate only when configured and requested by name:
  **Anthropic**, **OpenAI**, **Google Gemini**, **Kimi** (Moonshot AI,
  OpenAI-compatible), and **Ollama** — the open-source option that runs
  open-weight models (Llama, Mistral, Gemma, …) locally with no API key. An
  unconfigured vendor falls back to the mock.
- **Chat completions** logged to an append-only call log; idempotency keys
  dedupe repeated calls.
- **Embeddings** produced by a deterministic local model, cached by
  `(model, input_hash)` so repeat inputs never recompute.
- **RAG**: ingest documents into a collection and search them by cosine
  similarity.
- **Prompt management**: versioned prompt templates with `{{variable}}`
  interpolation and an active-version pointer.
- **Agents, image generation and speech** are present as documented `501`
  stubs — the planned surface without a v1 implementation.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Tests   | Vitest + Supertest (offline, deterministic) |

Runtime dependencies: `express`, `better-sqlite3`. The Anthropic adapter
uses the built-in `fetch`.

## Quickstart

Requires Node 20+.

```sh
cd platform/ps-04-ai-platform
npm install
npm run seed        # optional — the server also seeds an empty DB on boot
npm run dev:api     # API on http://localhost:4004
```

```sh
curl -s localhost:4004/api/health
# chat (service token) — deterministic mock reply:
curl -s -X POST localhost:4004/api/chat/completions \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
# retrieval over the seeded handbook collection:
curl -s -X POST localhost:4004/api/rag/search \
  -H 'X-Service-Token: dev-service-token' -H 'Content-Type: application/json' \
  -d '{"collection":"handbook","query":"what are platform services","k":2}'
```

Configure a vendor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`KIMI_API_KEY`, or `OLLAMA_BASE_URL`) and send
`{"provider":"anthropic"|"openai"|"gemini"|"kimi"|"ollama", ...}` to use a
real model — see [`.env.example`](./.env.example). Production build:
`npm run build && npm start`.

## API

Call endpoints accept an admin session **or** the shared `SERVICE_TOKEN`.
Prompt management requires the admin session. Errors are `{ error, details? }`.

| Method & path | Auth | Purpose |
| ------------- | ---- | ------- |
| `GET /api/health` | none | Liveness. |
| `POST /api/login` · `POST /api/logout` | none | Admin session. |
| `POST /api/chat/completions` | caller | `{messages\|prompt_key, variables?, provider?, model?}` → `{text, usage, provider}`. |
| `POST /api/embeddings` | caller | `{input}` → cached deterministic vectors. |
| `GET /api/prompts`, `GET /api/prompts/:key` | caller | Prompts + version details. |
| `POST /api/prompts` | admin | Create a prompt (v1). |
| `POST /api/prompts/:key/versions` | admin | Append a version. |
| `PUT /api/prompts/:key/active` | admin | Set the active version. |
| `POST /api/prompts/:key/render` | caller | Render the active template. |
| `GET /api/completions`, `GET /api/completions/:id` | caller | Call log. |
| `POST /api/rag/documents` | caller | Ingest + embed a document. |
| `POST /api/rag/search` | caller | Top-k cosine search. |
| `POST /api/agents/run` · `/api/images/generate` · `/api/speech/transcribe` | caller | Documented `501` stubs. |

## Consumed by

Business Modules, over this API. The AI Platform depends on no Business
Module. See [`.env.example`](./.env.example) for the (commented-out)
`IDENTITY_URL` seam.

## Tests

```sh
npm test
```

Covers deterministic mock chat (identical output, no network), prompt
versioning + render + active-pointer switch + missing-variable 422, the
embedding cache, deterministic RAG ranking, provider selection (Anthropic
only when keyed, mock otherwise), and the 501 stubs.
