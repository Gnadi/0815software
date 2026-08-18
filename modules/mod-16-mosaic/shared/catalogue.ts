/**
 * THE MODULE CATALOGUE — which modules this shell knows how to host.
 *
 * One entry per module in the 0815software catalogue, naming the two env vars
 * that point at it and whether it can be embedded. It is this module's half
 * of the peer declarations in `modules/registry.json`, and the two are checked
 * against each other by the registry drift test — a module added here without a
 * peer entry (or the reverse) fails the build rather than producing a tile that
 * can never light up.
 *
 * Why TWO urls per peer:
 *
 * - `urlEnv` is the INTERNAL address (`http://offers:3013`). This module's
 *   server calls `/api/summary` and the handoff routes over it, holding the
 *   machine token. It never leaves the stack's network.
 * - `publicUrlEnv` is the CUSTOMER-FACING origin (`https://offers.acme.example`).
 *   It is what an iframe's `src` and a deep link must use, because those are
 *   resolved by the operator's browser, which cannot reach a container name.
 *
 * Collapsing them into one is the mistake this file exists to prevent: a board
 * whose frames point at `http://offers:3013` renders as a column of failed
 * loads with nothing in any log, because the requests never reached the stack.
 *
 * `embeddable` is false for the three modules whose users are not staff —
 * MOD-01's portal customers, MOD-07's shop guests, MOD-09's matter users
 * (docs/PLATFORM-READINESS.md, item C1). A staff shell has no principal to
 * assert in those, so it shows their figures and links out rather than
 * offering a frame that could only fail. It is the same line
 * `constraints.supportsSso` draws in the registry.
 */

export interface CatalogueEntry {
  /** Registry id — also what a module reports as `module` in its summary. */
  id: string;
  /** Catalogue number, for display. */
  n: string;
  /** Short label, matching the registry's. */
  label: string;
  /** Env var holding the module's internal URL. */
  urlEnv: string;
  /** Env var holding the module's public, browser-reachable origin. */
  publicUrlEnv: string;
  /** Can this module be framed and handed a session? */
  embeddable: boolean;
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  { id: 'mod-01-customer-portal', n: 'MOD-01', label: 'Portal', urlEnv: 'PORTAL_URL', publicUrlEnv: 'PORTAL_PUBLIC_URL', embeddable: false },
  { id: 'mod-02-admin-dashboard', n: 'MOD-02', label: 'Admin', urlEnv: 'ADMIN_URL', publicUrlEnv: 'ADMIN_PUBLIC_URL', embeddable: true },
  { id: 'mod-03-inventory-management', n: 'MOD-03', label: 'Inventory', urlEnv: 'INVENTORY_URL', publicUrlEnv: 'INVENTORY_PUBLIC_URL', embeddable: true },
  { id: 'mod-04-invoice-billing', n: 'MOD-04', label: 'Invoicing', urlEnv: 'INVOICING_URL', publicUrlEnv: 'INVOICING_PUBLIC_URL', embeddable: true },
  { id: 'mod-05-employee-directory', n: 'MOD-05', label: 'Directory', urlEnv: 'DIRECTORY_URL', publicUrlEnv: 'DIRECTORY_PUBLIC_URL', embeddable: true },
  { id: 'mod-06-procurement-tracker', n: 'MOD-06', label: 'Procurement', urlEnv: 'PROCUREMENT_URL', publicUrlEnv: 'PROCUREMENT_PUBLIC_URL', embeddable: true },
  { id: 'mod-07-storefront', n: 'MOD-07', label: 'Shop', urlEnv: 'SHOP_URL', publicUrlEnv: 'SHOP_PUBLIC_URL', embeddable: false },
  { id: 'mod-08-reporting-suite', n: 'MOD-08', label: 'Reporting', urlEnv: 'REPORTING_URL', publicUrlEnv: 'REPORTING_PUBLIC_URL', embeddable: true },
  { id: 'mod-09-document-management', n: 'MOD-09', label: 'Documents', urlEnv: 'DOCUMENTS_URL', publicUrlEnv: 'DOCUMENTS_PUBLIC_URL', embeddable: false },
  { id: 'mod-10-crm-lite', n: 'MOD-10', label: 'CRM', urlEnv: 'CRM_URL', publicUrlEnv: 'CRM_PUBLIC_URL', embeddable: true },
  { id: 'mod-11-time-tracking', n: 'MOD-11', label: 'Time', urlEnv: 'TIME_URL', publicUrlEnv: 'TIME_PUBLIC_URL', embeddable: true },
  { id: 'mod-12-support-tickets', n: 'MOD-12', label: 'Support', urlEnv: 'SUPPORT_URL', publicUrlEnv: 'SUPPORT_PUBLIC_URL', embeddable: true },
  { id: 'mod-13-offers', n: 'MOD-13', label: 'Offers', urlEnv: 'OFFERS_URL', publicUrlEnv: 'OFFERS_PUBLIC_URL', embeddable: true },
  { id: 'mod-14-subsidies-funds', n: 'MOD-14', label: 'Subsidies', urlEnv: 'SUBSIDIES_URL', publicUrlEnv: 'SUBSIDIES_PUBLIC_URL', embeddable: true },
  // The Workspace is a module like any other from here: a pane can hold the
  // whole board. This module is absent on purpose — framing itself is a
  // recursion with no bottom.
  { id: 'mod-15-workspace', n: 'MOD-15', label: 'Workspace', urlEnv: 'WORKSPACE_URL', publicUrlEnv: 'WORKSPACE_PUBLIC_URL', embeddable: true },
];

export function catalogueEntry(id: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === id);
}
