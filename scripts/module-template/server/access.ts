import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:{{SLUG}}:<level>`
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
export const MODULE_SLUG = '{{SLUG}}';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // Archiving takes an item out of everyone's list; the example of a `manage` action.
  { method: 'POST', path: '/api/items/:id/archive', access: 'manage' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
