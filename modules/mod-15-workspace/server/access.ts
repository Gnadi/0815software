import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:workspace:<level>`
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
export const MODULE_SLUG = 'workspace';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // Boards are personal — every query filters on the owner — so arranging your
  // own is not editing anything anyone else sees: `view` is enough. What a
  // board DOES in other modules is decided by those modules, at the level PS-01
  // grants there (grants.ts).
  { method: 'POST', path: '/api/boards', access: 'view' },
  { method: 'PUT', path: '/api/boards/:id', access: 'view' },
  { method: 'DELETE', path: '/api/boards/:id', access: 'view' },
  { method: 'POST', path: '/api/boards/:id/active', access: 'view' },
  { method: 'POST', path: '/api/boards/:id/widgets', access: 'view' },
  { method: 'DELETE', path: '/api/boards/:id/widgets/:widgetId', access: 'view' },
  { method: 'PUT', path: '/api/boards/:id/layout', access: 'view' },
  { method: 'PUT', path: '/api/context', access: 'view' },
  { method: 'POST', path: '/api/actions/:id', access: 'view' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
