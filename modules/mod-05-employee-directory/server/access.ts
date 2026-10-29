import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:employee-directory:<level>`
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
export const MODULE_SLUG = 'employee-directory';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // Self-service: one's own record, whatever the level — keeping one's own
  // phone number or emergency contact current is not editing the directory.
  // The paths carry no id; server/profile.ts acts on the signed-in person only.
  { method: 'PUT', path: '/api/me/profile', access: 'view' },
  { method: 'POST', path: '/api/me/profile/requests', access: 'view' },
  { method: 'POST', path: '/api/me/profile/requests/:id/withdraw', access: 'view' },
  // Private data and the change requests are HR's to see and decide (`edit`,
  // the level that maintains records); nobody decides their own request
  // (server/profile.ts, mayDecide).
  { method: 'GET', path: '/api/profile-requests', access: 'edit' },
  { method: 'GET', path: '/api/employees/:id/private', access: 'edit' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
