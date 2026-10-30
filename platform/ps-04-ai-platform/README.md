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
- **Document extraction** (`POST /api/extract/invoice`): a supplier invoice
  in, fields a person checks out — supplier, VAT ID, IBAN, number, dates,
  net/tax/gross, purchase order — each with how sure it is. See
  [Document extraction](#document-extraction).
- **Agents, image generation and speech** run on a deterministic offline
  mock by default (an agent is a bounded tool-less loop over the chat
  provider; images are placeholder SVG data URIs; transcription echoes a
  reference), with optional real OpenAI adapters when a key is configured.

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
| `POST /api/extract/invoice` | caller | `{content_base64\|text, own?, provider?}` → fields + confidence + lines + warnings. Saves nothing. |
| `POST /api/agents/run` | caller | Bounded agent loop over the chat provider; `{goal, prompt_key?, max_steps?}`. |
| `POST /api/images/generate` | caller | `{prompt}` → image (mock SVG data URI, or OpenAI when keyed). |
| `POST /api/speech/transcribe` | caller | `{audio_ref}` → transcript (mock, or OpenAI when keyed). |

## Document extraction

Reading a supplier invoice so nobody types it in — the incoming side of
what MOD-04 writes as e-invoices. Consumed by MOD-04 (bills); the expenses
module and MOD-09 are the next intended callers.

The first route that applies wins, in order of trust:

| Document | Read by | Confidence |
| --- | --- | --- |
| E-invoice XML — CII (XRechnung, Factur-X), UBL 2.1 (XRechnung, PEPPOL), ebInterface | the EN 16931 elements (BT-1, BT-2, BT-9, BT-13, BT-27, BT-31, BT-84, BT-109…BT-115) | `exact` |
| ZUGFeRD / Factur-X PDF | the embedded XML, as above | `exact` |
| A generated PDF (text layer), or pasted text | labelled patterns — "Rechnungsnummer", "Fällig am", "Gesamtbetrag", "IBAN" … — offline and deterministic; or the named model when `provider` is sent and configured | `found` / `derived` / `guess`, or `model` |
| A scan or a photo (PNG, JPEG, a PDF without text) | a vision model only: `provider: "anthropic"` with `ANTHROPIC_API_KEY` | `model` |

What it holds to:

- **No model is asked what an XML says.** An e-invoice is structured data;
  reading it is parsing, and a model could only make it worse.
- **The default never invents.** A scan without a vision model is a 422
  that says what is needed, not plausible placeholder values — the mock
  posture of the other capabilities would be dangerous here. A field
  without a label next to it stays empty.
- **The buyer is not the supplier.** The caller sends its own names, VAT IDs
  and IBANs (`own`); they are never taken as the supplier's, and a model is
  told who the recipient is.
- **Checked, not trusted.** IBAN check digits (ISO 13616), net + tax =
  gross, prepaid amounts, a non-EUR currency, a credit note, a due date
  before the issue date — each a warning the person sees before saving.
- **Nothing is saved, little is logged.** The result is a proposal. The
  `extractions` log keeps the document's SHA-256, the route taken and which
  fields came out — never names, amounts or bank accounts.
- **No dependencies.** The XML reader (`server/xml.ts`) skips DTDs instead of
  expanding entities; the PDF reader (`server/pdf-read.ts`) inflates streams
  with `node:zlib` and reads literal-string text shown in single-byte fonts.
  Composite fonts without a usable map yield no text, and the PDF goes the
  vision route or is refused.

**Lines** come with the fields: description, the supplier's article number
(BT-155 — what a PO line's SKU is compared with), quantity and unit, unit
price, net, VAT rate. An e-invoice gives them exactly, a model gives them
when it read the document; the labelled-pattern reader does not guess a
table. When the lines do not add up to the net, a warning says so — an
allowance or charge on the whole invoice is legal (BT-107/108).

Pinned by `test/extraction.test.ts`: the EN 16931 example invoice from the
European Commission's eInvoicing-EN16931 repository (EUPL 1.2), in UBL and
CII, must read to identical fields; MOD-04's schema-validated XRechnung,
ebInterface and ZUGFeRD output must read back to what MOD-04 wrote.

## Consumed by

Business Modules, over this API. The AI Platform depends on no Business
Module. Set `IDENTITY_URL` (see [`.env.example`](./.env.example)) to verify
end-user callers against PS-01's `POST /api/tokens/verify`; unset, the
service runs standalone on its own admin/service-token.

## Tests

```sh
npm test
```

Covers deterministic mock chat (identical output, no network), prompt
versioning + render + active-pointer switch + missing-variable 422, the
embedding cache, deterministic RAG ranking, provider selection (Anthropic
only when keyed, mock otherwise), and the agents/images/speech capabilities.

## API contract

The full endpoint + auth surface is documented in [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1). Request/response *shapes* are typed in
[`@0815software/platform-clients`](../clients) and pinned by `test/contract.test.ts`,
which boots this service and drives the real client over HTTP — so the client and
the service cannot drift apart unnoticed.
