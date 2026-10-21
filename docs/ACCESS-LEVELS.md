# Access levels — the multi-user contract

*How several people use one module, each with their own login and their own
level. Introduced October 2026; replaces "one staff admin by design".*

## The rule in one paragraph

A module keeps **no user table**. Who a person is and what they may do in a
module are both answered by [PS-01 Identity](../platform/ps-01-identity), as
permissions of the form `module:<slug>:<level>`. The module turns those into
one of three levels when the person signs in, carries the level in its own
session token, and holds **every** `/api` request against one policy file,
`server/access.ts`, before any route runs. Standalone — no PS-01 — the local
admin login exists exactly as before and always manages.

## Levels

| Level | May | Default for |
| --- | --- | --- |
| `view` | read everything the module shows; change nothing | `GET`, `HEAD`, `OPTIONS` |
| `edit` | the day-to-day work: create, update, delete, transition | every other method |
| `manage` | also the actions a module's `access.ts` reserves | — |

Ordered: `manage` ⊃ `edit` ⊃ `view`.

## Permissions in PS-01

| Permission | Grants |
| --- | --- |
| `module:<slug>:<level>` | that level in the module whose registry `slug` is `<slug>` |
| `module:*:<level>` | that level in every module |
| `platform:admin` | `manage` everywhere — what an SSO login required before levels existed |

PS-01 never enforces these — by the architecture rule it knows no module by
name — so they are a **grammar**, not part of its closed catalogue:
`platform/ps-01-identity/shared/module-access.ts`. It stores them on custom
roles, returns them on `POST /api/tokens/verify`, and applies its grant caps
to them with the same implication the modules use (an Administrator holding
`platform:admin` may grant any module level; a principal holding only
`module:crm-lite:view` may not grant `edit`). The modules' copy of the grammar
is `platform/clients/src/access.ts`; `platform/clients/test/access.test.ts`
holds the two to the same answers.

Granting someone `edit` on the CRM:

```sh
# as an Owner or Administrator of the org
curl -s -X POST $IDENTITY_URL/api/roles -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"key":"crm-editor","name":"CRM editor","permissions":["module:crm-lite:edit"]}'
curl -s -X POST $IDENTITY_URL/api/users/$USER_ID/roles -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"role_id": <id from above>}'
```

## Inside a module

Four files, each with one job:

| File | Job |
| --- | --- |
| `server/access.ts` | `MODULE_SLUG` and the rules — the only file to read or change |
| `server/sso.ts` | turns PS-01's permissions into a level at login (`accessLevelFor`); no grant = rejected login |
| `server/auth.ts` | carries the level in the session token; `requireAuth` enforces the policy; `accessOf(res)` reads it |
| `server/handoff.ts` | a shell may name a level (`access`), signed into the ticket; unnamed = `manage` |

**Default-deny by method.** A rule is only written where the method default is
wrong — a `POST` that merely reads (`view`), or an action consequential enough
for `manage`:

```ts
export const ACCESS_RULES: readonly AccessRule[] = [
  { method: 'POST', path: '/api/logout', access: 'view' },
  { method: 'POST', path: '/api/payment-runs/:id/submit', access: 'manage' },
];
```

A route added later is protected by the default without anyone remembering to
protect it. `test/access.test.ts` (byte-identical in every module) proves the
default, every rule in both directions, that every rule names a route the
module really has, and that `MODULE_SLUG` is the module's registry slug.

**What the module stamps.** The actor (PS-01 email, or the local admin) rides
next to the level and ends up on every audit entry and history row, as before.

**What the frontend sees.** `GET /api/me` (MOD-02: `GET /api/config`) and the
login response report `access`, so a UI can hide what the person cannot do. The
UIs do not do that yet; a refused request answers **403**
`{ error: 'Insufficient access', required, access }`.

## Compatibility

- **No `module:` grant anywhere** behaves exactly as before: `platform:admin`
  manages, everyone else is refused at login.
- **`IDENTITY_PERMISSION` set** restores the old rule verbatim: that one
  permission admits, as `manage`.
- **Sessions minted before the upgrade** (two- and three-part tokens) stay
  valid until they expire, as `manage` — every session was an administrator's
  then. Drop those branches in `auth.ts` once one `SESSION_TTL_HOURS` has passed.

## Not yet

- **Shells (MOD-15, MOD-16) admit platform administrators only.** A shell signs
  its user into every module on the board and cannot yet tell each module what
  that person may do there. The next step: resolve the target's level from
  PS-01 (the shell already holds the person's PS-01 token for PS-07 reads) and
  pass it as `access` on the handoff, which the modules already accept.
- **Per-record rules** ("only my own timesheet", "only this warehouse") —
  a level covers the whole module.
- **MOD-01, MOD-07, MOD-09** have their own user models (customers, the public
  shop, matter members) and are not part of this contract.
