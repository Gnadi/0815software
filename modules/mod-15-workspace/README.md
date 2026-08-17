# MOD-15 · Workspace

One screen for a stack of modules. A per-person, drag-and-drop board of
widgets fed live by the modules a customer licensed, one shared customer/date
context every widget honours, the full module UI embeddable inside the board,
and cross-module actions that run as the person who clicked. Part of the
[0815software](https://0815software.com) module catalogue — standard business
software, MIT-licensed, always free.

**The Workspace adds no capability to any module and takes none away.** Every
module still installs, runs and ships on its own, exactly as before; every
figure on a board is fetched live from the module that owns it, and this
module stores nothing but layouts.

## Stack

Deliberately standard and boring:

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Styling  | hand-rolled CSS, no framework                 |
| Grid     | CSS grid + pointer events, no DnD library     |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`, `react-dom`, and
`@0815software/platform-clients`. That's all.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-15-workspace
npm install

# terminal 1 — API on :3015
npm run dev:api

# terminal 2 — UI on :5205 (proxies /api to :3015)
npm run dev:web
```

Open http://localhost:5205 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3015
```

With nothing else configured it runs standalone: a board with a launcher and
an activity feed, both saying honestly that no modules are wired and no audit
service is configured. It becomes useful when you point it at modules.

## Putting modules on the board

Each module needs two addresses, and they are **not** interchangeable:

| Variable              | Used by                | Example                    |
| --------------------- | ---------------------- | -------------------------- |
| `<MODULE>_URL`        | this server            | `http://offers:3013`       |
| `<MODULE>_PUBLIC_URL` | the operator's browser | `https://offers.acme.example` |

The internal URL is where summaries and session handoffs are fetched from; the
public one is what an iframe's `src` and a deep link must use, because a
browser cannot reach a container name. Setting only the internal one is valid
— that module's figures appear, but it cannot be embedded or linked to.

Every module also needs the stack's `PLATFORM_SERVICE_TOKEN`: it is what a
module requires before it will answer a summary at all.

```sh
PLATFORM_SERVICE_TOKEN=…
OFFERS_URL=http://offers:3013
OFFERS_PUBLIC_URL=https://offers.acme.example
INVOICING_URL=http://invoicing:3004
INVOICING_PUBLIC_URL=https://invoicing.acme.example
```

`deploy/provision.mjs` writes all of this for a selection that includes this
module, including the matching `SHELL_ORIGIN` on the other side. See
[`docs/SHELL-CONTRACT.md`](../../docs/SHELL-CONTRACT.md).

## What a module has to do to appear here

Nothing that changes how it behaves on its own. A module joins a board by
serving **`GET /api/summary`** — a neutral shape of figures, short lists and
module-relative paths, guarded by the machine token and closed without one.
The contract is `shared/summary.ts`, byte-identical in every module.

To be *embedded*, a module also sets `SHELL_ORIGIN` to this Workspace's
origin. That one variable swaps its blanket `X-Frame-Options: DENY` for a
`frame-ancestors` naming this shell, and opens two handoff routes. Unset — the
default, and every standalone install — none of it exists.

## Working across modules

- **One context, every widget.** Pick a customer (a PS-11 party, so it means
  the same thing in every module) and a date range once in the bar; every
  widget re-asks its module that question. A module that cannot honour a
  filter says so rather than showing an unfiltered answer as a filtered one.
- **Open a module inside the board.** Its real UI, already signed in, in a
  frame — no second login and no second tab. The module mints its own session
  from a single-use ticket; this Workspace never sees its cookie.
- **Act across modules.** An accepted offer in the MOD-13 widget carries a
  **BILL THIS** button that creates the draft invoice in MOD-04 without either
  UI being opened. It calls MOD-04's *existing* import route with a session
  belonging to whoever clicked, so the invoice names that person in MOD-04's
  own history — the shell has no privilege of its own.
- **One activity feed.** Read from PS-07 Audit Log, which every module already
  writes to.

Three modules are deliberately **not** embeddable: MOD-01 Customer Portal,
MOD-07 Storefront and MOD-09 Document Management authenticate their own end
users — portal customers, shop guests, matter users — so a staff shell has no
identity to assert in them. They contribute widgets and open in a new tab.

## Boards

Boards are **per person**, keyed by the signed-in identity. With SSO
configured that is the PS-01 user, so colleagues sharing a stack keep separate
layouts; standalone, everyone shares the local admin account and therefore one
set of boards. A board belonging to someone else answers `404`, the same as
one that never existed.

Drag a widget by its header, resize it from the corner, add with **ADD
WIDGET** — which lists what the peers actually offered on the last refresh, so
a module that adds a tile in a new version appears here without this module
changing. Widgets may overlap: the grid never moves something you did not
touch.

## What it stores

Layouts, and nothing else:

- `boards` — name, position, owner
- `widgets` — which module and key a widget shows, and where it sits
- `preferences` — the active board and the context bar's selection

There is deliberately **no cache of peer data**. It would make the board fast
and wrong, and "wrong but fast" is not a trade a dashboard gets to make. It
also means losing this file costs a layout, never a record.

An open board re-asks every module once a minute, and pauses while its tab is
hidden. Simultaneous refreshes for the same customer and date range share one
round of requests per module — deduplication of a call already in flight, not a
cache: nothing survives the request, so every figure is still one the owning
module produced just then.

## Platform integration

Opt-in and best-effort, like every module in the catalogue:

- **PS-01 Identity** — `IDENTITY_URL` + `IDENTITY_ORG`: PS-01 validates the
  login and this module issues its own session carrying that identity. It is
  what makes boards per person and what puts a real name on cross-module
  actions.
- **PS-07 Audit Log** — `AUDIT_URL`: the activity feed, and where this module
  records the actions a board performs.
- **PS-11 Customers** — `CUSTOMERS_URL`: the context bar's customer picker.

Unset, each degrades to nothing and the board keeps working.

## Tests

```sh
npm test
```

The suites worth knowing about: `test/peers.test.ts` covers what the board
does when a module is down, slow, older than the contract, or claiming to be
something else — one sick module must cost one widget, never the board — and
`test/boards.test.ts` covers layout isolation between people.

## Licence

MIT. See [LICENSE](./LICENSE).
