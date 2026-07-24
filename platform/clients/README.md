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
  (PS-05), `FilesClient` (PS-06), `AuditClient` (PS-07).
- Every client extends a shared `BaseClient` that presents `X-Service-Token`
  for machine calls and forwards an end-user's PS-01 session token as
  `Authorization: Bearer` when supplied — the identity-propagation path.
- A non-2xx response raises a typed `ServiceError` carrying the status and the
  service's `{ error }` body.
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

## Develop

```sh
cd platform/clients
npm install
npm test     # vitest, fully offline (injected fetch)
npm run build
```
