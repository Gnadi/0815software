# MOD-16 · Mosaic

The modules themselves, tiled. Every pane is a **whole module** running in its
own process, drawn into a frame and already signed in — arranged on a
drag-and-drop grid you control. No widgets, no summaries, no second
implementation of anything. Part of the
[0815software](https://0815software.com) module catalogue — standard business
software, MIT-licensed, always free.

**Mosaic adds no capability to any module and takes none away.** Every module
still installs, runs and ships on its own; this one stores nothing but which
module sits where.

## Mosaic or Workspace?

Both are shells over the same catalogue, and a stack can run both — they are
not alternatives.

| | [MOD-15 Workspace](../mod-15-workspace) | MOD-16 Mosaic |
| --- | --- | --- |
| A panel is | a widget: one figure, or a short list | the module itself, whole |
| Data comes from | `GET /api/summary` on each module | the module, rendering itself |
| You get | one customer filter across everything, an activity feed, cross-module buttons | the real UI, with everything it can do |
| Good for | watching a business at a glance | working in several modules at once |

Put another way: the Workspace **summarises** the modules; Mosaic **runs** them
side by side. If you want to read this month's overdue invoices, use the
Workspace. If you want the Invoicing app open next to the Offers app while you
work, use Mosaic.

## Stack

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Styling  | hand-rolled CSS, no framework                 |
| Grid     | CSS grid + pointer events, no DnD library     |
| Tests    | Vitest + Supertest                            |

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-16-mosaic
npm install

npm run dev:api      # API on :3016
npm run dev:web      # UI on :5206 (proxies /api to :3016)
```

Sign in with **admin / admin** locally. With nothing else configured you get an
empty board and a picker that says honestly that nothing can be tiled yet.

## Putting a module on a board

A pane needs **three** things, and all three are the operator's to set:

| What | Where | Why |
| --- | --- | --- |
| `<MODULE>_URL` | here | this server asks the module for a ticket |
| `<MODULE>_PUBLIC_URL` | here | the browser loads the frame from it — a container name will not resolve |
| `SHELL_ORIGIN` | on **that module** | its `frame-ancestors` must name this origin, or the browser refuses the frame |

```sh
PLATFORM_SERVICE_TOKEN=…
OFFERS_URL=http://offers:3013
OFFERS_PUBLIC_URL=https://offers.acme.example
```

…and on MOD-13 itself, `SHELL_ORIGIN=https://mosaic.acme.example`. It is a
comma-separated list, so a stack running both shells names both.

`deploy/provision.mjs` writes all of it for a selection that includes this
module. See [`docs/SHELL-CONTRACT.md`](../../docs/SHELL-CONTRACT.md).

## Already signed in

A pane does not show a login form. When it opens, this module asks the target
for a **single-use, 30-second ticket**; the browser lands on that module's
`/session/handoff`, and the module mints **its own** session for the person at
the keyboard, sets its own cookie and redirects.

Mosaic never sees that cookie and holds no credential for anybody. The module
stays the sole authority over its own sessions — only the assertion of *who* is
delegated, and only because the operator named this origin in `SHELL_ORIGIN`.

Because the ticket redeems once, a pane fetches its URL **once** and holds it.
Reloading a pane asks for a fresh ticket; there is a button for it.

## What cannot be tiled

**MOD-01 Customer Portal, MOD-07 Storefront and MOD-09 Document Management.**
They authenticate their own end users — portal customers, shop guests, matter
users — so a staff shell has no identity to assert in them, and a frame would
show a login nobody here can fill. The picker lists them as unavailable and the
API refuses them; hiding them without saying why is how someone spends an
afternoon checking URLs.

MOD-15 Workspace **can** be tiled: from here it is a module like any other.
This module cannot tile itself, which is a recursion with no bottom.

## Boards

Boards are **per person**, keyed by the signed-in identity — the PS-01 user
with SSO configured, the local admin otherwise. A board belonging to somebody
else answers `404`, the same as one that never existed. Without an identity
provider everyone shares one account, and the board says so above the grid
rather than letting you find out.

Drag a pane by its header, resize from the corner, add with **ADD PANE**. Panes
may overlap: the grid never moves something you did not touch. The minimum size
is a quarter of the width — narrower than that, a real application is unusable
rather than merely small.

## What it stores

Which module sits where, and nothing else:

- `boards` — name, position, owner
- `panes` — module id and placement
- `preferences` — the active board

There is nothing to cache: a pane is not a rendering of a module's data, it *is*
the module. Losing this file costs an arrangement, never a record.

## Platform integration

- **PS-01 Identity** — `IDENTITY_URL` + `IDENTITY_ORG`: makes boards per person
  and puts a real name in each module's own history when a pane opens.
- **PS-07 Audit Log** — `AUDIT_URL`: records how a screen came to look the way
  it does. Written only; this module reads nothing back.

PS-11 is deliberately absent: there is no shared filter here to narrow, because
each pane is the module's own UI with its own filters.

## Tests

```sh
npm test
```

`test/panes.test.ts` covers what may go on a board and what may not, the
handoff, and that two people never see each other's arrangement.

## Licence

MIT. See [LICENSE](./LICENSE).
