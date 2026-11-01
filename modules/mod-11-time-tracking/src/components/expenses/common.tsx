import type { ClaimStatus } from '../../../shared/expense-types';
import type { ExpenseCategory, Vehicle } from '../../../shared/expenses';

/** Amounts as people type them — "12,40", "12.40", "1.234,50" — in cents, or null. */
export function parseEuro(text: string): number | null {
  const t = text.trim().replace(/\s|€/g, '');
  if (t === '') return null;
  const normalized = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  travel: 'Train, flight, bus',
  accommodation: 'Hotel',
  meals: 'Meals',
  fuel: 'Fuel',
  parking: 'Parking',
  taxi: 'Taxi',
  office: 'Office supplies',
  hospitality: 'Hospitality (guests)',
  other: 'Other',
};

export const VEHICLE_LABEL: Record<Vehicle, string> = { car: 'Car', motorbike: 'Motorbike or moped', bicycle: 'Bicycle' };

export function ClaimBadge({ status }: { status: ClaimStatus }) {
  const cls = status === 'approved' || status === 'paid' ? 'badge--active' : status === 'submitted' ? 'badge--submitted' : 'badge--offboarded';
  return <span className={`badge ${cls}`}>{status.toUpperCase()}</span>;
}

/** "2026-10-05T07:00" as "05.10. 07:00". */
export function fmtLocal(local: string): string {
  return `${local.slice(8, 10)}.${local.slice(5, 7)}. ${local.slice(11, 16)}`;
}

export const fmtKm = (tenths: number) => `${(tenths / 10).toFixed(1).replace('.', ',')} km`;

export function fmtMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`;
}
