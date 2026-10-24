/**
 * Units of measure a line is billed in (BT-130), as UN/ECE Recommendation 20
 * codes — the list EN 16931 prescribes (BR-CL-23). A choice for invoices of
 * services and goods, not the 2,000-odd codes of the list; each one is in it
 * as the CEN schematron 1.3.16 carries it, and the golden case `units` takes
 * every one through the reference validator.
 *
 * Every line used to go out as C62 ("one"), so three consulting days were
 * three pieces (review N7). C62 stays the default, and prints no label: a
 * line of pieces reads as it always did.
 */
export const UNITS = {
  C62: { name: 'piece', label: '' },
  HUR: { name: 'hour', label: 'h' },
  DAY: { name: 'day', label: 'd' },
  WEE: { name: 'week', label: 'wk' },
  MON: { name: 'month', label: 'mo' },
  ANN: { name: 'year', label: 'yr' },
  MIN: { name: 'minute', label: 'min' },
  LS: { name: 'lump sum', label: 'LS' },
  KMT: { name: 'kilometre', label: 'km' },
  KGM: { name: 'kilogram', label: 'kg' },
  TNE: { name: 'tonne', label: 't' },
  MTR: { name: 'metre', label: 'm' },
  MTK: { name: 'square metre', label: 'm²' },
  MTQ: { name: 'cubic metre', label: 'm³' },
  LTR: { name: 'litre', label: 'l' },
  KWH: { name: 'kilowatt hour', label: 'kWh' },
  SET: { name: 'set', label: 'set' },
  PR: { name: 'pair', label: 'pr' },
} as const satisfies Record<string, { name: string; label: string }>;

export type UnitCode = keyof typeof UNITS;

export const UNIT_CODES = Object.keys(UNITS) as UnitCode[];

/** What a line is in when nobody said: every line before units existed. */
export const DEFAULT_UNIT: UnitCode = 'C62';

export function isUnitCode(value: unknown): value is UnitCode {
  return typeof value === 'string' && Object.hasOwn(UNITS, value);
}

/** The quantity with its unit, as the PDF and the screens show it: "7,5 h", "3". */
export function withUnit(quantity: string, unit: string | null | undefined): string {
  const label = isUnitCode(unit) ? UNITS[unit].label : '';
  return label === '' ? quantity : `${quantity} ${label}`;
}
