# @0815software/platform-clients

Typed HTTP clients for the [Platform Services](../README.md) catalog. A
Business Module installs this one package and talks to any service through a
small, typed client instead of hand-rolling `fetch`, auth headers and error
handling.

Part of the Platform Services catalog. Zero runtime dependencies — a thin
wrapper over the built-in `fetch`, matching the services' own "no SDKs" rule.

## What it is

- One client per service: `IdentityClient` (PS-01), `WorkflowClient` (PS-02),
  `NotificationClient` (PS-03), `AiClient` (PS-04), `IntegrationClient`
  (PS-05), `FilesClient` (PS-06), `AuditClient` (PS-07), `PaymentsClient`
  (PS-08), `SearchClient` (PS-09), `NumberClient` (PS-10).
- Every client extends a shared `BaseClient` that presents `X-Service-Token`
  for machine calls and forwards an end-user's PS-01 session token as
  `Authorization: Bearer` when supplied — the identity-propagation path.
- A non-2xx response raises a typed `ServiceError` carrying the status and the
  service's `{ error }` body.
- Every request is **bounded** (`timeoutMs`, default 10 s) so a service that
  accepts the connection and then stalls cannot hold a module's request open;
  a **GET** is retried once by default (`retries`, `retryDelayMs`) after a
  timeout, a transport failure or a 502/503/504. Writes are never replayed —
  the client cannot know whether one carried an idempotency key, so replaying
  is the caller's decision, made with a key the service understands.
- The `fetch` implementation is injectable (`ClientOptions.fetch`), so module
  tests exercise the wiring completely offline.

## Usage

```ts
import { NotificationClient, AuditClient } from '@0815software/platform-clients';

const notify = new NotificationClient({
  baseUrl: process.env.NOTIFICATION_URL!, // e.g. http://localhost:4003
  serviceToken: process.env.NOTIFICATION_SERVICE_TOKEN!,
});

await notify.send({
  channel: 'transactional-email',
  to: customer.email,
  template_key: 'invoice-sent',
  variables: { number: invoice.number, total: invoice.total },
});
```

Modules construct clients lazily and **degrade gracefully**: when a service
URL is unset, the module keeps its standalone local behavior and never
constructs the client.

## Install

External consumers install the published package from npm:

```sh
npm install @0815software/platform-clients
```

Modules **inside this repo** consume it as a local `file:` dependency and let
npm build it on install — each module's `.npmrc` sets `install-links=true`, so
npm packs the package (running its `prepack` build) rather than symlinking
source. Nothing is committed pre-built; there is no checked-in `dist/`.

```jsonc
// modules/mod-XX/package.json
"dependencies": {
  "@0815software/platform-clients": "file:../../platform/clients"
}
```

```ini
# modules/mod-XX/.npmrc
install-links=true
```

## Develop

```sh
cd platform/clients
npm install
npm test         # vitest, fully offline (injected fetch)
npm run build    # emits dist/ (also run automatically by prepack)
```

## Publish

The package is published to npm by CI. Cut a release by pushing a tag:

```sh
# bump platform/clients/package.json "version", commit, then:
git tag platform-clients-v0.1.0
git push origin platform-clients-v0.1.0
```

The [`publish-platform-clients`](../../.github/workflows/publish-platform-clients.yml)
workflow builds, tests and runs `npm publish` with provenance, using the repo
secret `NPM_TOKEN`. Validate locally first with `npm publish --dry-run`.
