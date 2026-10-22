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
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
