// ─── Use cases ──────────────────────────────────────────────────────────────
// Example businesses for the /use-cases page: which modules each one runs, how
// work flows between them, and what is still open — further catalogue modules,
// building blocks that are not a standard module yet, and work for Claude.
//
// Only the structure lives here. Every string is a dictionary entry in
// src/i18n/use-cases.ts, keyed `uc.<id>.…`, so the page and the language toggle
// read the same copy. Module references are registry slugs and are checked
// against the catalogue below, so a renamed or removed module fails the build
// instead of rendering a dead link.
import { modules } from './modules';

export interface UseCase {
  /** Anchor on the page and the key prefix: `uc.<id>.title`, `uc.<id>.situation`, … */
  id: string;
  n: string;
  /** Modules this business runs. Copy: `uc.<id>.use.<slug>`. */
  uses: string[];
  /** One module per step of the typical flow. Copy: `uc.<id>.flow.<i>`. */
  flow: string[];
  /** Catalogue modules it does not run yet. Copy: `uc.<id>.next.<slug>`. */
  next: string[];
  /** Building blocks that are not a standard module. Copy: `uc.<id>.custom.<i>.title|body`. */
  custom: number;
  /** What Claude can take on. Copy: `uc.<id>.ai.<i>`. */
  ai: number;
}

export const useCases: UseCase[] = [
  {
    id: 'hospitality',
    n: 'UC-01',
    uses: ['inventory-management', 'procurement-tracker', 'crm-lite', 'offers', 'storefront', 'time-tracking', 'invoice-billing', 'workspace'],
    flow: ['crm-lite', 'offers', 'workspace', 'invoice-billing'],
    next: ['document-management', 'reporting-suite', 'employee-directory', 'subsidies-funds'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'trades',
    n: 'UC-02',
    uses: ['offers', 'time-tracking', 'inventory-management', 'procurement-tracker', 'invoice-billing', 'customer-portal', 'document-management', 'workspace'],
    flow: ['offers', 'workspace', 'time-tracking', 'invoice-billing'],
    next: ['support-tickets', 'crm-lite', 'reporting-suite', 'employee-directory'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'tax',
    n: 'UC-03',
    uses: ['document-management', 'customer-portal', 'support-tickets', 'time-tracking', 'invoice-billing', 'employee-directory'],
    flow: ['support-tickets', 'document-management', 'time-tracking', 'invoice-billing'],
    next: ['crm-lite', 'reporting-suite', 'workspace', 'mosaic'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'wholesale',
    n: 'UC-04',
    uses: ['storefront', 'inventory-management', 'procurement-tracker', 'customer-portal', 'invoice-billing', 'reporting-suite'],
    flow: ['inventory-management', 'procurement-tracker', 'inventory-management', 'customer-portal'],
    next: ['crm-lite', 'offers', 'support-tickets', 'workspace'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'agency',
    n: 'UC-05',
    uses: ['crm-lite', 'offers', 'time-tracking', 'support-tickets', 'invoice-billing', 'workspace', 'mosaic'],
    flow: ['crm-lite', 'offers', 'time-tracking', 'invoice-billing'],
    next: ['customer-portal', 'document-management', 'reporting-suite', 'employee-directory'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'nonprofit',
    n: 'UC-06',
    uses: ['subsidies-funds', 'time-tracking', 'document-management', 'procurement-tracker', 'employee-directory', 'reporting-suite'],
    flow: ['subsidies-funds', 'time-tracking', 'document-management', 'reporting-suite'],
    next: ['invoice-billing', 'crm-lite', 'storefront', 'workspace'],
    custom: 4,
    ai: 4,
  },
];

const slugs = new Set(modules.map((m) => m.slug));
for (const uc of useCases) {
  for (const slug of [...uc.uses, ...uc.next]) {
    if (!slugs.has(slug)) throw new Error(`use case ${uc.id} names unknown module "${slug}"`);
  }
  for (const slug of uc.flow) {
    if (!uc.uses.includes(slug)) throw new Error(`use case ${uc.id}: flow step "${slug}" is not a module it uses`);
  }
  for (const slug of uc.next) {
    if (uc.uses.includes(slug)) throw new Error(`use case ${uc.id}: "${slug}" is both in use and listed as next`);
  }
}
