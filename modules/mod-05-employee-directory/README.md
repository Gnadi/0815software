# MOD-05 · Employee Directory

Org chart, roles, contact data, and department structure. Integrates
with HR onboarding. Part of the [0815software](https://0815software.com)
module catalogue — standard business software, MIT-licensed, always
free.

Two correctness properties are the point of this module, and the test
suite proves both of them:

1. **The manager graph is a forest.** Every employee has at most one
   manager; nobody can manage themselves, directly or transitively. Any
   assignment that would create a cycle — self-reference, a 2-node
   swap, or a deep chain looping back — is rejected with 422 by a
   transitive walk *inside the write transaction*, so no interleaving
   of requests can corrupt the chart. Roots are simply employees
   without a manager (the org chart supports several).
2. **Employees are never deleted.** Leaving the company is a status
   flip to `offboarded` with a timestamp: the record, its manager link
   and its department stay for history, but the employee disappears
   from the org chart and the default directory view. Offboarding a
   manager who still has active reports is refused (409) so the chart
   never orphans a subtree.

## Stack

Deliberately standard and boring (same as MOD-01 … MOD-04):

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Vite + React 19 + TypeScript (strict)         |
| API      | Node + Express 5                              |
| Storage  | better-sqlite3 (single file, zero services)   |
| Styling  | Hand-rolled CSS, no framework                 |
| Tests    | Vitest + Supertest                            |

Runtime dependencies: `express`, `better-sqlite3`, `react`,
`react-dom`. That's all — fully offline, no CDN, no external services.

## Quickstart

Requires Node 20+.

```sh
cd modules/mod-05-employee-directory
npm install
npm run seed          # creates ./data.db with example data (idempotent)

# terminal 1 — API on :3005
npm run dev:api

# terminal 2 — UI on :5195 (proxies /api to :3005)
npm run dev:web
```

Open http://localhost:5195 and sign in with the local-dev default
credentials **admin / admin**.

Production-style single process (API + built client on one port):

```sh
npm run build
npm start             # http://localhost:3005
```

The server seeds an empty database automatically on first start, so
`npm run seed` is optional. The seed contains 5 departments (Platform
nested under Engineering) and 21 employees in a three-level hierarchy
with two org chart roots, a couple of upcoming starters (dates relative
to the seeding day, so the onboarding view always has content) and one
offboarded former employee. No binary database file is committed;
delete `data.db` at any time to start fresh.

## Data model

Three tables, no stored derived state:

```
departments            name, code (unique), parent_id (tree), created_at
employees              name, email (unique, case-insensitive), job_title,
                       department, manager_id (forest), phone, location,
                       start_date, status (active | offboarded),
                       offboarded_at, created_at
onboarding_checklists  employee → account_created, hardware_issued,
                       intro_meeting_booked (three stored booleans)
```

- **Departments** form a tree via `parent_id`; reparenting a department
  under its own descendant is rejected (422) by the same
  chain-walk-in-transaction technique as the manager forest. A
  department can only be deleted while it is completely empty — no
  employees of *any* status (offboarded employees keep their history)
  and no child departments; otherwise 409.
- **Employees** always belong to a department and optionally report to
  a manager. A CHECK constraint rules out direct self-management and
  ties `offboarded_at` to the `offboarded` status; the domain layer
  enforces the rest (cycle-free chart, unique email with a 422 field
  error, active managers only).
- **Derived, never stored:** direct-report counts, the manager chain,
  the org chart tree, and the onboarding window are all computed at
  read time.

## Org chart rules

- The chart shows **active employees only**. Roots are active employees
  with no manager — the seed has two.
- Setting a manager that would create a cycle → **422**, checked
  transitively inside the write transaction. The tests prove all three
  shapes: direct self-reference, 2-node cycle, deep transitive cycle.
- An offboarded employee cannot be assigned as a manager (422), and an
  employee with active reports cannot be offboarded (409 — reassign the
  reports first). Together these keep the chart a forest of active
  people at all times.
- Reactivating an offboarded employee restores them; if their old
  manager left in the meantime, the link is cleared and they come back
  as a root.

## Onboarding view

"Integrates with HR onboarding" kept honest and small: employees whose
start date falls within the **next 30 days or the last 14 days** appear
in a "starting soon / just started" list, each with a three-item stored
checklist — account created, hardware issued, intro meeting booked.
The window is always computed relative to today; toggling a flag is a
`PATCH` with partial semantics, so flags never reset each other. Real
HRIS integration (Personio, BambooHR, Workday, …) is **out of scope** —
see below.

## Features

- **Directory** — searchable list (name, email, title) with department,
  location, and status filters; report counts; offboarded rows dimmed.
- **Employee detail** — contact card, manager chain up to the root,
  direct reports, edit, offboard / reactivate.
- **Departments** — CRUD over the tree with employee/child counts;
  deletion guarded (409) while non-empty.
- **Org chart** — collapsible indented tree per root with department
  badges and report counts.
- **Onboarding** — starting soon / just started with the stored
  checklist flags, toggled inline.
- **CSV export** — RFC-4180 CSV of the directory honouring the active
  filters (`/api/employees/export.csv`).
- **Auth** — single staff login from env vars; stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, optional Secure), exactly as
  in MOD-02 … MOD-04.

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                | Purpose                             |
| ------------------- | ---------------------- | ----------------------------------- |
| `PORT`              | `3005`                 | API / production server port        |
| `DATABASE_PATH`     | `./data.db`            | SQLite file (created on demand)     |
| `ADMIN_USERNAME`    | `admin`                | Login user                          |
| `ADMIN_PASSWORD`    | `admin`                | Login password — **change in prod** |
| `SESSION_SECRET`    | `dev-secret-change-me` | HMAC key for the session cookie     |
| `SESSION_TTL_HOURS` | `12`                   | Session lifetime                    |
| `COOKIE_SECURE`     | `false`                | Set `true` behind HTTPS             |

The server prints a warning on startup while the default password is in
use. The dev server does not load `.env` files by itself — export the
variables in your shell or use `node --env-file`.

## API

All routes under `/api`, JSON in/out, session cookie required except
for `POST /api/login` and `GET /api/health`.

```
POST   /api/login                        {username, password} → session cookie
POST   /api/logout
GET    /api/me

GET    /api/departments                  list with parent + derived counts
POST   /api/departments                  {name, code, parent_id?}
GET    /api/departments/:id
PUT    /api/departments/:id              parent cycle → 422
DELETE /api/departments/:id              409 while employees or children exist

GET    /api/employees                    ?search=&department=&location=&status=
GET    /api/employees/export.csv         same filters, RFC-4180 CSV download
POST   /api/employees                    {name, email, job_title, department_id,
                                          manager_id?, phone?, location?, start_date}
GET    /api/employees/:id                detail + manager_chain + reports + onboarding
PUT    /api/employees/:id                manager cycle → 422, duplicate email → 422
POST   /api/employees/:id/offboard       soft state; active reports → 409
POST   /api/employees/:id/reactivate     stale manager link is cleared
PATCH  /api/employees/:id/onboarding     {account_created?, hardware_issued?,
                                          intro_meeting_booked?} — partial

GET    /api/orgchart                     {roots: [...]} — active employees only
GET    /api/onboarding                   {today, upcoming, recent} — ±30/14-day window
GET    /api/locations                    distinct locations (filter dropdown)
```

Validation failures return `422` with `{error, details: [{field,
message}]}`; state conflicts (deleting a non-empty department,
offboarding twice or with active reports) return `409`.

## Scripts

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run dev:api` | API with reload (tsx watch)                             |
| `npm run dev:web` | Vite dev server with `/api` proxy                       |
| `npm run seed`    | Create/seed the SQLite database (skips non-empty DBs)   |
| `npm run build`   | Type-check (client + server) and build both to `dist/`  |
| `npm start`       | Run the production server (serves API + built client)   |
| `npm test`        | Invariant + API tests (Vitest, in-memory SQLite)        |

The tests prove the properties that matter: all three cycle shapes
rejected with 422 (self, 2-node, deep transitive), department-delete
guards (409 for employees and for children), duplicate email 422
(case-insensitive), offboarding removing an employee from the chart
while the record stays fetchable, manager-chain order up to the root,
the onboarding window computed relative to today (no hardcoded dates),
checklist flags that don't reset each other, valid quoted CSV honouring
filters, and 401 everywhere without a session.

## Deploy notes

This is an *internal* tool — put it behind your VPN or reverse proxy.

- Any box with Node 20+ works: `npm ci && npm run build && npm start`
  under systemd, Docker, or a PaaS that allows a persistent disk (the
  SQLite file must survive restarts — mount a volume for `DATABASE_PATH`).
- Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
  (`openssl rand -hex 32`) and `COOKIE_SECURE=true`, and terminate TLS
  in front (Caddy/nginx).
- Not a fit for serverless platforms: SQLite wants a persistent filesystem.

## Out of scope

Kept out deliberately to stay a 2–3 week module — the smallest in the
catalogue so far. If you need any of these, that's commissioned work —
exactly the kind 0815software does:

- **Real HRIS integration** — no Personio/BambooHR/Workday sync, no
  webhooks, no SCIM. "Integrates with HR onboarding" means the built-in
  starting-soon list and checklist; the clean REST API is the hook for
  anything deeper.
- **Multi-user accounts and roles** — one staff admin by design (same
  auth pattern as MOD-02 … MOD-04). No employee self-service login.
- **Photos and file uploads** — contact data is text; an avatar/photo
  pipeline (storage, resizing) is an extension.
- **Leave, payroll, and performance** — this is a directory, not an
  HR suite. No absence calendars, salaries, or review cycles.
- **Matrix / dotted-line reporting** — exactly one manager per
  employee; the forest invariant is the point of the module.
- **Employee history timelines** — the current state plus the
  offboarded flag is stored, not an audit trail of every change.

## License

MIT © 0815software — see [LICENSE](LICENSE).
