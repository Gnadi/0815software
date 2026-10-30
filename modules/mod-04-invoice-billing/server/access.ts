import { compileAccessPolicy, type AccessRule } from '@0815software/platform-clients';

/**
 * Who may do what in this module — the one file to read, and the one to change.
 *
 * People get a level here from PS-01 Identity: `module:invoice-billing:<level>`
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
export const MODULE_SLUG = 'invoice-billing';

export const ACCESS_RULES: readonly AccessRule[] = [
  // Signing out is never refused, whatever the level.
  { method: 'POST', path: '/api/logout', access: 'view' },
  // Freezes a SEPA payment file — money leaves the account.
  { method: 'POST', path: '/api/payment-runs', access: 'manage' },
  // Sends the run to the bank over EBICS.
  { method: 'POST', path: '/api/payment-runs/:id/submit', access: 'manage' },
  // Records that the bank paid it.
  { method: 'POST', path: '/api/payment-runs/:id/mark-executed', access: 'manage' },
  // Throws a frozen run away.
  { method: 'POST', path: '/api/payment-runs/:id/discard', access: 'manage' },
  // The company itself: the name, VAT id and IBAN every future invoice and
  // e-invoice prints, and the debtor account of every payment file. Changing
  // it is administration, not day-to-day invoicing.
  { method: 'PUT', path: '/api/settings/seller', access: 'manage' },
  // The tax adviser's DATEV / BMD numbers, accounts and tax codes — a wrong
  // value books every exported invoice on the wrong account.
  { method: 'PUT', path: '/api/accounting-settings', access: 'manage' },
  // A dunning run writes to every overdue customer at once.
  { method: 'POST', path: '/api/dunning/run', access: 'manage' },
  // The dunning levels, fees and interest rate are policy, not daily work.
  { method: 'PUT', path: '/api/dunning-settings', access: 'manage' },
  // Drafts for every template at once — the month-end run, not daily work.
  { method: 'POST', path: '/api/recurring/run', access: 'manage' },
  // Paying a bill the three-way match holds — more than was received, or
  // than was ordered — is a decision someone answers for, with a reason.
  { method: 'POST', path: '/api/bills/:id/release-match', access: 'manage' },
  // Whether supplier invoices may be sent to an outside model to be read is
  // a data-protection decision, not daily work.
  { method: 'PUT', path: '/api/settings/bill-reading', access: 'manage' },
];

export const accessPolicy = compileAccessPolicy(ACCESS_RULES);
