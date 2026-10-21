import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:reporting-suite:<level>`
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
export const MODULE_SLUG = 'reporting-suite';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // A report is hand-written SQL against the source database.
  { method: 'POST', path: '/api/reports', access: 'manage' },
  // Changes that SQL.
  { method: 'PUT', path: '/api/reports/:id', access: 'manage' },
  // Removes a report other people read.
  { method: 'DELETE', path: '/api/reports/:id', access: 'manage' },
  // Runs arbitrary SQL that is not yet a saved report.
  { method: 'POST', path: '/api/preview', access: 'manage' },
  // Runs a saved report; reads only.
  { method: 'POST', path: '/api/reports/:id/run', access: 'view' },
  // Pivots a saved report; reads only.
  { method: 'POST', path: '/api/reports/:id/pivot', access: 'view' },
  // Renders a chart of a saved report; reads only.
  { method: 'POST', path: '/api/reports/:id/chart-preview', access: 'view' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
