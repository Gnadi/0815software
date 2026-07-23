# PS-03 · Notification Hub

Centralized notification service for the 0815software platform. One place
to compose, template, queue and deliver messages across every channel, so
no module has to integrate a mail provider or push service directly.

Part of the [Platform Services catalog](../README.md). **Status: Planned —
not yet implemented.** This README documents intended scope only.

## Purpose

Give every module a single API to notify people, with consistent
templating and reliable delivery regardless of channel.

## Responsibilities

- **Email** — transactional and bulk mail.
- **SMS** — text-message delivery.
- **Push** — mobile and web push notifications.
- **Slack** — messages to Slack workspaces.
- **Teams** — messages to Microsoft Teams.
- **Discord** — messages to Discord servers.
- **Webhooks** — notify external systems over HTTP.
- **Templates** — reusable, localizable message content.
- **Queues** — buffered, retryable delivery.

## Consumed by

Business Modules, over an API. The Notification Hub depends on no Business
Module.
