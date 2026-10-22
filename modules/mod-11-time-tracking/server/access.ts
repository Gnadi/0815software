import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:time-tracking:<level>`
 * (or `module:*:<level>`, or `platform:admin`, which means `manage`). The local
 * admin login always manages. `auth.ts` holds every request under /api against
 * this policy before any route runs:
 *
 *   - reading (GET) needs `view`,
 *   - anything else needs `edit`,
 *   - unless a rule below says otherwise.
 *
 * So a new route is protected by default. A rule is only needed where the
 * default is wrong — a POST that merely reads, or an action consequential
 * enough to need `manage`. Paths are written exactly as on the route.
 */

/** This module's slug in `modules/registry.json`, and in its PS-01 permissions. */
export const MODULE_SLUG = 'time-tracking';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // Approval locks a week for payroll and billing.
  { method: 'POST', path: '/api/timesheets/approve', access: 'manage' },
  // The other half of approving.
  { method: 'POST', path: '/api/timesheets/reject', access: 'manage' },
  // Who works here, what they work on and at what rate is the office's to
  // maintain; `edit` records time against it. Which ROWS of time an editor may
  // write — only their own — is server/ownership.ts, because it depends on the row.
  { method: 'POST', path: '/api/employees', access: 'manage' },
  { method: 'PUT', path: '/api/employees/:id', access: 'manage' },
  { method: 'DELETE', path: '/api/employees/:id', access: 'manage' },
  { method: 'POST', path: '/api/projects', access: 'manage' },
  { method: 'POST', path: '/api/projects/import-offer', access: 'manage' },
  { method: 'PUT', path: '/api/projects/:id', access: 'manage' },
  { method: 'DELETE', path: '/api/projects/:id', access: 'manage' },
  { method: 'POST', path: '/api/projects/:id/tasks', access: 'manage' },
  { method: 'PUT', path: '/api/tasks/:id', access: 'manage' },
  { method: 'DELETE', path: '/api/tasks/:id', access: 'manage' },
  // Leave: deciding, the entitlement ledger and the holiday calendar are the
  // office's. Requesting and withdrawing one's own is `edit`; whose leave an
  // editor may touch is server/leave.ts (mayActFor), and nobody decides their
  // own request even with `manage` (mayDecide).
  { method: 'POST', path: '/api/leave/requests/:id/approve', access: 'manage' },
  { method: 'POST', path: '/api/leave/requests/:id/reject', access: 'manage' },
  { method: 'POST', path: '/api/employees/:id/entitlements', access: 'manage' },
  { method: 'PUT', path: '/api/leave/settings', access: 'manage' },
  // Working time: the schedule is the contract, and what enters or leaves a
  // flexitime account besides the days themselves (opening balance,
  // corrections, overtime paid out) is the office's decision.
  { method: 'POST', path: '/api/employees/:id/schedules', access: 'manage' },
  { method: 'POST', path: '/api/employees/:id/flex-entries', access: 'manage' },
  // Planning: who does what by when, estimates and milestones are the office's.
  // Moving a task across the board is `edit` — and only one's own task, which
  // depends on the row: server/ownership.ts (mayMoveTask).
  { method: 'PUT', path: '/api/tasks/:id/plan', access: 'manage' },
  { method: 'POST', path: '/api/projects/:id/milestones', access: 'manage' },
  { method: 'PUT', path: '/api/milestones/:id', access: 'manage' },
  { method: 'DELETE', path: '/api/milestones/:id', access: 'manage' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
