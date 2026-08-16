import type { AbsenceTypeDef } from '../shared/types.js';

/**
 * The absence types, in ONE file — the MOD-06 / MOD-10 / MOD-14 pattern.
 *
 * These are policy, not code: which absences draw down the annual entitlement
 * and which need an approver are decisions a company makes, and changing them
 * should be editing this list rather than hunting through handlers.
 *
 * Two of the flags carry legal weight rather than preference:
 *
 * - **Sick leave does not deduct.** Counting illness against someone's holiday
 *   is unlawful in Germany (§ 9 BUrlG) and Austria (§ 5 UrlG) — a sick day
 *   during booked leave is even given back. Setting `deducts: true` here would
 *   be a compliance defect, not a configuration choice.
 * - **Sick leave needs no approval.** An approver cannot decline an illness.
 *   It is recorded as a fact that already happened, which is why it lands
 *   `approved` immediately.
 */
export const ABSENCE_TYPES: AbsenceTypeDef[] = [
  { key: 'vacation', label: 'Urlaub / Vacation', deducts: true, needsApproval: true },
  { key: 'sick', label: 'Krankheit / Sick leave', deducts: false, needsApproval: false },
  { key: 'unpaid', label: 'Unbezahlter Urlaub / Unpaid leave', deducts: false, needsApproval: true },
  { key: 'special', label: 'Sonderurlaub / Special leave', deducts: false, needsApproval: true },
  {
    // Austria's replacement for Karfreitag: one day a year, chosen by the
    // employee, which the employer cannot refuse (§ 7a ARG). Modelled as a
    // type rather than a holiday precisely because it is not a fixed date.
    key: 'personal_holiday',
    label: 'Persönlicher Feiertag (AT)',
    deducts: true,
    needsApproval: false,
  },
];

const BY_KEY = new Map(ABSENCE_TYPES.map((type) => [type.key, type]));

export function absenceType(key: string): AbsenceTypeDef | undefined {
  return BY_KEY.get(key);
}

export function isAbsenceType(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key);
}

/** Types whose days come off the annual entitlement. */
export function deducts(key: string): boolean {
  return absenceType(key)?.deducts === true;
}

// Config that would silently misbehave is refused at import time, the way
// MOD-06's approval tiers and MOD-10's pipeline are.
const seen = new Set<string>();
for (const type of ABSENCE_TYPES) {
  if (seen.has(type.key)) throw new Error(`absence-config: duplicate type key ${type.key}`);
  seen.add(type.key);
  if (type.key.trim() === '') throw new Error('absence-config: a type key may not be blank');
}
if (!BY_KEY.has('vacation')) throw new Error('absence-config: the "vacation" type is required');
