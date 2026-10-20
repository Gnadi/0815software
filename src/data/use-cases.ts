// ─── Use cases ──────────────────────────────────────────────────────────────
// Example businesses for the /use-cases page: which modules each one runs, how
// it looks in practice, and what is still open — further catalogue modules,
// building blocks that are not a standard module yet, and work for Claude.
//
// Only the structure lives here. Every string is a dictionary entry in
// src/i18n/use-cases.ts, keyed `uc.<id>.…`, so the page and the language toggle
// read the same copy. Module references are registry slugs and are checked
// against the catalogue below, so a renamed or removed module fails the build
// instead of rendering a dead link.
import { modules } from './modules';
import { UC } from '../i18n/use-cases';

export interface UseCase {
  /** Anchor on the page and the key prefix: `uc.<id>.title`, `uc.<id>.situation`, … */
  id: string;
  n: string;
  /**
   * Modules this business runs. Copy: `uc.<id>.use.<slug>`, plus the practice
   * story `uc.<id>.story`, which must link each of them and no other module.
   */
  uses: string[];
  /**
   * Problem → solution pairs, one module each, that the business has solved
   * with what exists today. Copy: `uc.<id>.solved.<i>.before|after`.
   */
  solved: string[];
  /** Catalogue modules it could add later. Copy: `uc.<id>.next.<slug>`. */
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
    solved: ['inventory-management', 'offers', 'storefront'],
    next: ['document-management', 'reporting-suite', 'employee-directory', 'subsidies-funds'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'trades',
    n: 'UC-02',
    uses: ['offers', 'time-tracking', 'inventory-management', 'procurement-tracker', 'invoice-billing', 'document-management', 'workspace'],
    solved: ['offers', 'time-tracking', 'invoice-billing'],
    next: ['support-tickets', 'customer-portal', 'crm-lite', 'employee-directory'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'tax',
    n: 'UC-03',
    uses: ['document-management', 'support-tickets', 'time-tracking', 'invoice-billing', 'employee-directory'],
    solved: ['support-tickets', 'document-management', 'time-tracking'],
    next: ['crm-lite', 'customer-portal', 'reporting-suite', 'workspace'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'wholesale',
    n: 'UC-04',
    uses: ['storefront', 'inventory-management', 'procurement-tracker', 'invoice-billing', 'reporting-suite'],
    solved: ['inventory-management', 'storefront', 'procurement-tracker'],
    next: ['crm-lite', 'offers', 'support-tickets', 'customer-portal'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'agency',
    n: 'UC-05',
    uses: ['crm-lite', 'offers', 'time-tracking', 'support-tickets', 'invoice-billing', 'workspace', 'mosaic'],
    solved: ['crm-lite', 'workspace', 'support-tickets'],
    next: ['customer-portal', 'document-management', 'reporting-suite', 'employee-directory'],
    custom: 4,
    ai: 4,
  },
  {
    id: 'nonprofit',
    n: 'UC-06',
    uses: ['subsidies-funds', 'time-tracking', 'document-management', 'procurement-tracker', 'employee-directory'],
    solved: ['subsidies-funds', 'time-tracking', 'document-management'],
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
  for (const lang of ['en', 'de'] as const) {
    const story = UC[lang][`uc.${uc.id}.story`] ?? '';
    const linked = [...story.matchAll(/href="\/modules\/([a-z0-9-]+)"/g)].map((m) => m[1]);
    const missing = uc.uses.filter((slug) => !linked.includes(slug));
    const extra = linked.filter((slug) => !uc.uses.includes(slug));
    if (missing.length || extra.length) {
      throw new Error(`use case ${uc.id}: ${lang} story must link exactly the modules in use (missing: ${missing.join(', ') || '—'}; not in use: ${extra.join(', ') || '—'})`);
    }
  }
  for (const slug of uc.solved) {
    if (!uc.uses.includes(slug)) throw new Error(`use case ${uc.id}: solved by "${slug}", which it does not use`);
  }
  for (const slug of uc.next) {
    if (uc.uses.includes(slug)) throw new Error(`use case ${uc.id}: "${slug}" is both in use and listed as next`);
  }
}
