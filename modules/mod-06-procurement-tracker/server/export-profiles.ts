/**
 * ERP CSV export profiles — THE one place export formats live.
 *
 * "Export to any ERP CSV format" is kept honest by making formats data,
 * not code: a profile is a name plus a column list, each column a header
 * label, a field path from the documented set below, and an optional
 * money/date format. Adding a new ERP format = adding one entry to
 * EXPORT_PROFILES (see README for the walkthrough); the render engine in
 * ./csv.ts never changes.
 *
 * The export is line-based (one CSV row per PO line — what typical ERP
 * purchasing imports expect), covering POs that reached `ordered`.
 *
 * Field paths (the full documented set):
 *   po.number             "PO-2026-0001"
 *   po.supplier_name      supplier display name
 *   po.supplier_email     supplier email ('' when unset)
 *   po.supplier_contact   supplier contact person ('' when unset)
 *   po.currency           always "EUR"
 *   po.note               PO note ('' when unset)
 *   po.total_cents        PO total          (money-formattable)
 *   po.created_at         PO creation       (date-formattable)
 *   po.ordered_at         ordered timestamp (date-formattable)
 *   line.position         1-based line number
 *   line.description      line text
 *   line.quantity         numeric quantity
 *   line.unit             unit label ("pc", "kg", …)
 *   line.unit_price_cents unit net price    (money-formattable)
 *   line.net_cents        line net          (money-formattable)
 *
 * Money formats ('cents' is the default when omitted):
 *   cents          integer cents            123456
 *   decimal-dot    euros, dot decimals      1234.56
 *   decimal-comma  euros, comma decimals    1234,56
 * Date formats ('iso' is the default when omitted):
 *   iso            2026-07-18
 *   dmy-dot        18.07.2026
 *   ymd-compact    20260718
 */

export const EXPORT_FIELDS = [
  'po.number',
  'po.supplier_name',
  'po.supplier_email',
  'po.supplier_contact',
  'po.currency',
  'po.note',
  'po.total_cents',
  'po.created_at',
  'po.ordered_at',
  'line.position',
  'line.description',
  'line.quantity',
  'line.unit',
  'line.unit_price_cents',
  'line.net_cents',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export const MONEY_FORMATS = ['cents', 'decimal-dot', 'decimal-comma'] as const;
export type MoneyFormat = (typeof MONEY_FORMATS)[number];

export const DATE_FORMATS = ['iso', 'dmy-dot', 'ymd-compact'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface ExportColumn {
  header: string;
  field: ExportField;
  money?: MoneyFormat;
  date?: DateFormat;
}

export interface ExportProfile {
  name: string;
  description: string;
  delimiter: ',' | ';';
  columns: ExportColumn[];
}

/**
 * Three EXAMPLE profiles ship out of the box. They are deliberately
 * labelled "-style": conventions modelled on the respective ecosystems,
 * NOT certified import formats — map them against your ERP's actual
 * import spec before relying on them.
 */
export const EXPORT_PROFILES: ExportProfile[] = [
  {
    name: 'GENERIC',
    description: 'Plain snake_case CSV: ISO dates, dot-decimal euro amounts. A sane default for spreadsheet tools and custom imports.',
    delimiter: ',',
    columns: [
      { header: 'po_number', field: 'po.number' },
      { header: 'supplier', field: 'po.supplier_name' },
      { header: 'supplier_email', field: 'po.supplier_email' },
      { header: 'order_date', field: 'po.ordered_at', date: 'iso' },
      { header: 'currency', field: 'po.currency' },
      { header: 'line_no', field: 'line.position' },
      { header: 'description', field: 'line.description' },
      { header: 'quantity', field: 'line.quantity' },
      { header: 'unit', field: 'line.unit' },
      { header: 'unit_price', field: 'line.unit_price_cents', money: 'decimal-dot' },
      { header: 'line_total', field: 'line.net_cents', money: 'decimal-dot' },
      { header: 'po_total', field: 'po.total_cents', money: 'decimal-dot' },
    ],
  },
  {
    name: 'SAP-B1-STYLE',
    description: 'EXAMPLE ONLY — column names modelled on SAP Business One DTW purchasing imports (DocNum/CardName/…, compact YYYYMMDD dates). Not a certified SAP format.',
    delimiter: ',',
    columns: [
      { header: 'DocNum', field: 'po.number' },
      { header: 'CardName', field: 'po.supplier_name' },
      { header: 'DocDate', field: 'po.ordered_at', date: 'ymd-compact' },
      { header: 'DocCurrency', field: 'po.currency' },
      { header: 'LineNum', field: 'line.position' },
      { header: 'ItemDescription', field: 'line.description' },
      { header: 'Quantity', field: 'line.quantity' },
      { header: 'UomCode', field: 'line.unit' },
      { header: 'Price', field: 'line.unit_price_cents', money: 'decimal-dot' },
      { header: 'LineTotal', field: 'line.net_cents', money: 'decimal-dot' },
    ],
  },
  {
    name: 'DATEV-STYLE',
    description: 'EXAMPLE ONLY — German bookkeeping conventions in the DATEV spirit: semicolon-separated, DD.MM.YYYY dates, comma-decimal amounts. Not a certified DATEV format.',
    delimiter: ';',
    columns: [
      { header: 'Belegnummer', field: 'po.number' },
      { header: 'Lieferant', field: 'po.supplier_name' },
      { header: 'Belegdatum', field: 'po.ordered_at', date: 'dmy-dot' },
      { header: 'Waehrung', field: 'po.currency' },
      { header: 'Position', field: 'line.position' },
      { header: 'Bezeichnung', field: 'line.description' },
      { header: 'Menge', field: 'line.quantity' },
      { header: 'Einheit', field: 'line.unit' },
      { header: 'Einzelpreis', field: 'line.unit_price_cents', money: 'decimal-comma' },
      { header: 'Gesamtpreis', field: 'line.net_cents', money: 'decimal-comma' },
    ],
  },
];

export function getProfile(name: string): ExportProfile | undefined {
  return EXPORT_PROFILES.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

// ── Config self-check (runs once at import) ──────────────────────────
{
  const names = new Set<string>();
  for (const profile of EXPORT_PROFILES) {
    if (names.has(profile.name)) throw new Error(`export-profiles: duplicate profile name ${profile.name}`);
    names.add(profile.name);
    if (profile.columns.length === 0) throw new Error(`export-profiles: ${profile.name} has no columns`);
    for (const col of profile.columns) {
      if (!(EXPORT_FIELDS as readonly string[]).includes(col.field)) {
        throw new Error(`export-profiles: ${profile.name}/${col.header} uses unknown field ${col.field}`);
      }
      if (col.money && !col.field.endsWith('_cents')) {
        throw new Error(`export-profiles: ${profile.name}/${col.header} has a money format on a non-money field`);
      }
      if (col.date && !col.field.endsWith('_at')) {
        throw new Error(`export-profiles: ${profile.name}/${col.header} has a date format on a non-date field`);
      }
    }
  }
}
