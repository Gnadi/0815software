# The Shell Contract: `/api/summary`, `SHELL_ORIGIN` and handoff

*How a module appears on a dashboard without giving up its independence.
Decided August 2026, alongside MOD-15 Workspace.*

## The stance

**A module joins a board by answering three questions about itself. It gains no
capability from doing so, and loses none by not.**

Everything below is gated on configuration that is unset by default. With
`PLATFORM_SERVICE_TOKEN` and `SHELL_ORIGIN` unset — which is every standalone
install, and every stack that runs no Workspace — a module's bytes on the wire
are exactly what they were before this contract existed: the same
`X-Frame-Options: DENY`, the same closed endpoints, the same local login. That
is the property the whole design is built to keep, and every module's suite
asserts it rather than assuming it.

This is a **convention plus two env vars**, not a service. It costs no
container, no network hop and no per-customer runtime, in the same way
[`REPORTING-CONTRACT.md`](./REPORTING-CONTRACT.md) does.

## 1. The summary — what a module shows

**`GET /api/summary`**, authenticated with `PLATFORM_SERVICE_TOKEN` in
`X-Service-Token`. The shape is `shared/summary.ts`, byte-identical in every
module, the same copy-in convention `shared/transfer.ts` uses.

```ts
interface ModuleSummary {
  summary_version: number;
  module: string;          // 'mod-13-offers'
  generated_at: string;
  tiles: SummaryTile[];    // one figure each
  lists: SummaryList[];    // short excerpts, never tables
  context: ContextSupport; // what it narrowed by
}
```

Four rules, each enforced by `validateSummary`, which the shell runs on every
response and refuses the peer when it fails:

1. **The module formats its own values.** `value` is a display string the
   owning module produced — its currency, its rounding. The shell never
   re-formats a number it does not own, so a widget cannot disagree with the
   module's own screens.
2. **Links are module-relative paths, never absolute URLs.** A module does not
   reliably know its own public URL; the shell knows every peer's. A peer that
   could return an absolute URL would decide where the shell's UI navigates.
3. **Keys are stable.** `key` identifies a widget across responses, so a saved
   board survives an upgrade. Renaming a key retires the widget; changing a
   `label` does not. Keys are unique across a module's whole summary.
4. **Context is advertised and acknowledged** — see below.

The route **only claims a request that presents a machine token**, and falls
through otherwise. MOD-11 already served a session-guarded `/api/summary` of
its own, and this one is mounted above the session gate; without the
fallthrough it would shadow that endpoint. Giving one module a different path
was the alternative, and the uniform contract is worth more than the collision
costs.

### Context: `?party=&from=&to=`

The shell passes one shared context — a PS-11 party id and a date range — and
the module echoes in `context.applied` which filters it actually ran.

**A filter counts as applied when it RAN, not when it matched.** `party` on a
customer a module has never seen yields an empty widget, and
empty-because-filtered is a true answer. What the echo prevents is the other
case: a filter the shell sent, the module ignored, and the board then labelled
as narrowed. A board that says "filtered to Blaustern" while showing everyone's
rows is worse than one that admits it could not narrow.

Modules declare honestly what they can honour. MOD-03, MOD-06, MOD-11, MOD-12
and MOD-14 support no `party` — their counterparties are suppliers, funding
bodies and email addresses, not PS-11 parties. MOD-02 and MOD-05 support
nothing: a configured resource need not have a customer or a date column at
all, and a staff directory has neither.

### What a module declines to put on a board

**MOD-01 and MOD-09 return counts and no rows.** Their access control is per
customer and per matter, and the machine token names neither — so any list they
could hand a shell would be assembled across everyone at once, which is what
the rest of those modules exists to prevent. MOD-07 does carry rows: a shop's
orders are already staff-visible and there is no per-user rule to bypass.

**MOD-08 reports on the reporting machinery, not on the figures its reports
produce.** The numbers inside a report belong to the module that owns the data,
and it puts its own tiles on the board. A board carrying both would show one
figure twice, computed two ways, with no way to tell which to believe.

## 2. `SHELL_ORIGIN` — the embed opt-in

One env var, read by each module's `config.ts` and mapped to the registry's
`constraints.embeddable`. Unset is the default. Set to a shell's origin:

- `server/hardening.ts` emits `Content-Security-Policy: frame-ancestors
  <SHELL_ORIGIN>` **instead of** `X-Frame-Options: DENY`. The two are never
  sent together: browsers prefer the CSP, so a `DENY` beside it is a header
  that reads as a refusal, is ignored, and misleads whoever audits it.
- The two handoff routes below are mounted. Unset, they do not exist.

**Only the eleven modules with `supportsSso: true` are embeddable.** MOD-01,
MOD-07 and MOD-09 authenticate domain users — portal customers, shop guests,
matter users ([`PLATFORM-READINESS.md`](./PLATFORM-READINESS.md), item C1) — so
a staff shell has no principal to assert in them. `embeddable` implies
`supportsSso`, checked by the drift test: what a shell hands over is the
identity PS-01 validated.

## 3. Handoff — signing a shell's user in

The module stays the **sole authority over its own sessions**, the same stance
`server/sso.ts` takes about PS-01: only the assertion of WHO is delegated.

- **`POST /api/session/handoff`** `{ actor, path }` mints a single-use,
  30-second ticket and returns the path that redeems it. The shell puts that
  path (joined to the module's *public* origin) on an iframe's `src`; the
  browser lands on **`GET /session/handoff?ticket=…`**, the module mints its
  own session for that actor, sets its own cookie and redirects.
- **`POST /api/session/issue`** `{ actor }` returns a session token directly to
  the machine caller, which the shell replays as a `Cookie` header when calling
  the module's ordinary session-guarded API on that person's behalf.

The second is what makes cross-module actions need **no new write API
anywhere**: the shell calls the route the module already serves for its own UI,
as the user, so the module authorizes and records the action exactly as it
would from its own screens — and its audit trail names the person rather than a
service account.

### Cross-module actions: the sales chain

`POST /api/session/issue` is what lets the board declare actions in data rather
than code. `modules/mod-15-workspace/shared/actions.ts` names a source list, a
target module and a route the target **already serves for its own UI**; the
shell obtains a session for whoever clicked and calls it as them.

```
MOD-10 deal ──QUOTE THIS──▶ MOD-13 offer ──BILL THIS──▶ MOD-04 invoice
                                  │
                                  └──────PLAN WORK─────▶ MOD-11 project
```

Every arrow is a `GET …/transfer` on the source and a `POST …/import-…` on the
target, both carrying the same neutral `shared/transfer.ts` shape and both with
suites on each side. Three rules keep the chain honest:

1. **An importer names the kinds it accepts.** `TransferOrigin.kind` is `offer`
   or `deal`, and the difference is not decorative: a deal is a guess about
   money and an offer is a promise about it. MOD-04 refuses to bill a deal;
   MOD-13 refuses to re-quote an offer it already owns (that operation is a
   *revision*); MOD-11 refuses to staff work nobody has agreed to buy. Each
   refusal is explicit, because the shape validates either way — only the
   meaning is wrong.
2. **A module never adopts a number it did not choose.** MOD-10 exports
   `vat_rate: 0` because a CRM has no VAT concept, and MOD-13 substitutes its
   own default rather than quoting everything zero-rated. MOD-11 leaves an
   imported project's hourly rate at zero, because an offer's total says what
   the *job* costs and not how many hours are in it — a derived rate would look
   authoritative and be invented, and every timesheet total after it would
   inherit the invention.
3. **Every import is idempotent on `origin.reference`.** A board button is
   exactly the thing people click twice. The second click returns the first
   one's draft with `200` instead of `201`, so nobody ends up with two quotes
   for one job or one job's hours split across two projects.

The diagonals are missing on purpose. There is no deal → invoice button and no
deal → project button, because the modules that own invoices and projects
refuse those transfers — so the board does not offer what the catalogue would
reject.

Four properties the suites pin down:

1. **Domain separation.** Tickets are signed over `handoff.…`, sessions over
   `session.…`. Neither verifier accepts the other's output.
2. **The destination is signed, not passed.** The redirect target lives inside
   the ticket, so `/session/handoff` takes no redirect parameter and cannot
   become an open redirect — the obvious way to get this wrong.
3. **Single use, 30 seconds.** A ticket is remembered when issued and forgotten
   when redeemed. `Referrer-Policy: no-referrer` keeps it out of the next
   request's headers.
4. **Bound to the issuing module.** The signing key is that module's own
   `SESSION_SECRET`, so a ticket minted by one module is not redeemable at
   another even though both trust the same shell.

Tickets live in the process that minted them. That is correct — a ticket is a
baton, not a credential — and it is compatible with the deployment model
([`DEPLOYMENT-MODEL.md`](./DEPLOYMENT-MODEL.md)): one process per module per
customer stack.

## 4. Two URLs per peer

A consumer that renders a peer in a browser needs both:

| Registry field  | Value                        | Used by            |
| --------------- | ---------------------------- | ------------------ |
| `urlEnv`        | `http://offers:3013`         | the consumer's server |
| `publicUrlEnv`  | `https://offers.acme.example` | the operator's browser |

`deploy/provision.mjs` sets both, and sets `SHELL_ORIGIN` on every embeddable
module when a shell is in the selection. It identifies the shell by what it
**declares** — a module asking for a peer's public origin is precisely one that
will put that peer in a browser — never by its id, so a second shell would work
with no change to the generator.

## What this deliberately is not

- **A push channel.** Modules never call the shell. Everything is pull, so a
  module needs no knowledge of who is watching it and no delivery guarantees.
- **A cache.** The Workspace stores layouts and no peer data. A board is always
  showing figures the owning module produced just now — "wrong but fast" is not
  a trade a dashboard gets to make. It does share a fan-out already in flight
  between readers asking the same question at the same moment, which retains
  nothing and so is deduplication rather than caching.
- **A privilege.** The machine token opens summaries and mints sessions. It
  performs no writes anywhere; writes are done as a person or not at all.
- **A generic write API.** An action is added when the target already serves
  the route, and the catalogue grows one arrow at a time. What the shell can do
  across modules is always a subset of what a person could do by opening them.
- **A second place to define a number.** Every figure comes from the function
  the module's own screens already call.
