import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:support-tickets:<level>`
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
export const MODULE_SLUG = 'support-tickets';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // Filling a canned response for a ticket only reads.
  { method: 'POST', path: '/api/tickets/:ref/canned/:id/render', access: 'view' },
  // How the desk runs is a manager's: the SLA policy, the settings (ratings,
  // replies by email, the mailbox), the team's canned responses. Agents
  // (`edit`) work tickets within them.
  { method: 'PUT', path: '/api/sla-policy', access: 'manage' },
  { method: 'PUT', path: '/api/settings', access: 'manage' },
  { method: 'POST', path: '/api/canned-responses', access: 'manage' },
  { method: 'PUT', path: '/api/canned-responses/:id', access: 'manage' },
  { method: 'DELETE', path: '/api/canned-responses/:id', access: 'manage' },
  // The mailbox page lists PS-05's mailbox connections, and polling or
  // testing it reaches the mail server.
  { method: 'GET', path: '/api/mailbox', access: 'manage' },
  { method: 'POST', path: '/api/mailbox/test', access: 'manage' },
  { method: 'POST', path: '/api/mailbox/poll', access: 'manage' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
