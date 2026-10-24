import type { ExtractedFields, FieldConfidence } from '../shared/types.js';

/**
 * Reading a supplier invoice from its text — the PDF a supplier's software
 * printed, or text pasted from one — with labelled patterns only.
 *
 * Every value here comes from a label next to it ("Rechnungsnummer",
 * "Fällig am", "Gesamtbetrag", "IBAN" …) or from a pattern that cannot be
 * mistaken (an IBAN whose check digits hold). A field without either stays
 * empty: an empty field costs a person ten seconds of typing, a confidently
 * wrong amount costs a payment to the wrong account or of the wrong sum.
 *
 * The invoice also names the *buyer* — its VAT ID, often its bank — so the
 * caller passes its own identifiers and those are never taken as the
 * supplier's.
 */

export interface OwnIdentity {
  names?: string[];
  vat_ids?: string[];
  ibans?: string[];
}

const compact = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** ISO 13616 mod-97: the check digits of an IBAN. */
export function ibanValid(raw: string): boolean {
  const iban = compact(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/**
 * "1.234,56" · "1,234.56" · "1234.56" · "1 234,56" → cents. The decimal
 * separator is the last of `.`/`,` followed by exactly two digits; anything
 * else is not an amount (a date, a quantity, a postcode).
 */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[€\s]|EUR/g, '').replace(/^-/, '');
  const m = /^(\d{1,3}(?:[.,' ]\d{3})*|\d+)([.,])(\d{2})$/.exec(s);
  if (!m) return null;
  const whole = m[1]!.replace(/[.,' ]/g, '');
  // "1,234,56" is not a number in any locale — the grouping must differ.
  if (m[1]!.includes(m[2]!)) return null;
  return Number(whole) * 100 + Number(m[3]);
}

const AMOUNT = /-?(?:€\s?)?(?:\d{1,3}(?:[.,' ]\d{3})+|\d+)[.,]\d{2}(?!\d)(?:\s?(?:€|EUR))?/g;

function amountsIn(line: string): number[] {
  return [...line.matchAll(AMOUNT)].map((m) => parseAmount(m[0])).filter((v): v is number => v !== null);
}

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, jänner: 1, feb: 2, februar: 2, february: 2, mär: 3, märz: 3, mar: 3, march: 3, apr: 4, april: 4,
  mai: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, november: 11, dez: 12, dec: 12, dezember: 12, december: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** The first date in a string: 21.10.2026 · 2026-10-21 · 21. Oktober 2026. Never US-style. */
export function firstDate(s: string): string | null {
  const re = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)|(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]{3,9})\.?\s+(\d{4})/g;
  for (const m of s.matchAll(re)) {
    let found: string | null = null;
    if (m[1]) found = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    else if (m[4]) {
      const y = m[6]!.length === 2 ? 2000 + Number(m[6]) : Number(m[6]);
      found = isoDate(y, Number(m[5]), Number(m[4]));
    } else if (m[7]) {
      const month = MONTHS[m[8]!.toLowerCase()];
      if (month) found = isoDate(Number(m[9]), month, Number(m[7]));
    }
    if (found) return found;
  }
  return null;
}

const LABEL = {
  number: /\b(?:rechnungs?[- ]?(?:nummer|nr\.?|no\.?)|rechnung\s+nr\.?|beleg[- ]?(?:nummer|nr\.?)|invoice\s*(?:no\.?|number|nr\.?|#)|gutschrift(?:s(?:nummer|-?nr\.?))?\s+nr\.?|credit\s+note\s+(?:no\.?|number))\s*[:#]?\s*/i,
  issue: /\b(?:rechnungsdatum|belegdatum|ausstellungsdatum|invoice\s+date|issue\s+date|datum|date)\b\s*:?/i,
  due: /\b(?:fällig(?:keit(?:sdatum)?)?(?:\s+am)?|zahlbar\s+(?:bis|am)|zahlungsziel|due\s+date|payment\s+due|due\s+(?:on|by)|bis\s+spätestens)\b\s*:?/i,
  po: /\b(?:ihre\s+bestell(?:ung|nummer|-?nr\.?)|bestell(?:nummer|-?nr\.?|ung\s+nr\.?)|auftrags?(?:nummer|-?nr\.?)|your\s+(?:order|ref(?:erence)?\.?|po)|purchase\s+order(?:\s+(?:no\.?|number))?|po\s*(?:no\.?|number|#)|order\s+(?:no\.?|number))\s*[:#]?\s*/i,
  gross: [
    /\b(?:zahlbetrag|zu\s+zahlen(?:der\s+betrag)?|offener\s+betrag|amount\s+due|balance\s+due|total\s+due)\b/i,
    /\b(?:gesamtbetrag|rechnungsbetrag|bruttobetrag|endbetrag|gesamt\s+brutto|summe\s+brutto|brutto(?:summe)?|gross\s+total|grand\s+total|total\s+(?:incl|inkl)|invoice\s+total)\b/i,
    /^\s*(?:summe|gesamt|total)\b/i,
  ],
  net: /\b(?:nettobetrag|summe\s+netto|gesamt\s+netto|netto(?:summe)?|zwischensumme|net\s+total|total\s+net|net\s+amount|subtotal)\b/i,
  tax: /\b(?:ust\.?|mwst\.?|umsatzsteuer|mehrwertsteuer|vat|tax)\b/i,
  taxTotal: /\b(?:summe\s+(?:ust|mwst|umsatzsteuer)|(?:ust|mwst|umsatzsteuer|vat|tax)[- ]?(?:summe|gesamt|total|betrag|amount))\b/i,
  vatId: /\b(?:uid(?:-?nr\.?)?|ust-?id(?:-?nr\.?)?|ust\.?-?idnr\.?|vat\s*(?:id|no\.?|number|reg(?:istration)?\.?)|tva|btw)\b\s*:?\s*/i,
  bic: /\b(?:BIC|SWIFT|Bic|Swift)\b\s*:?\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/,
};

const LEGAL_FORM = /\b(?:GmbH|AG|KG|OG|OHG|GesbR|e\.\s?U\.|e\.K\.|UG|SE|SA|S\.A\.|SAS|SARL|S\.r\.l\.|BV|B\.V\.|NV|Ltd\.?|Limited|LLC|Inc\.?|plc|Oy|AB|A\/S|ApS|sp\.\s?z\s?o\.o\.)(?=\s|$|,|\b)/;
const VAT_ID = /\b(ATU\d{8}|DE\d{9}|CHE[- ]?\d{3}\.?\d{3}\.?\d{3}|(?:BE|NL|FR|IT|ES|PL|CZ|SK|HU|SI|HR|DK|SE|FI|IE|LU|PT|GR|EL|RO|BG|EE|LV|LT|MT|CY)[0-9A-Z.]{8,14})\b/;
const INVOICE_NO = /^([A-Z0-9][A-Z0-9\-\/._]{0,39})/i;

interface Found {
  fields: ExtractedFields;
  confidence: Partial<Record<keyof ExtractedFields, FieldConfidence>>;
  warnings: string[];
}

/** The value after a label: on the same line, or — for stacked layouts — the next one. */
function afterLabel(lines: string[], label: RegExp, read: (s: string) => string | null, skip?: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (skip?.test(lines[i]!)) continue;
    const m = label.exec(lines[i]!);
    if (!m) continue;
    const rest = lines[i]!.slice(m.index + m[0].length);
    const here = read(rest);
    if (here) return here;
    if (rest.trim() === '' && lines[i + 1]) {
      const below = read(lines[i + 1]!);
      if (below) return below;
    }
  }
  return null;
}

export function readInvoiceText(text: string, own: OwnIdentity = {}): Found {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, ' ').replace(/[ \t]+$/, ''))
    .filter((l) => l.trim() !== '');
  const fields: ExtractedFields = emptyFields();
  const confidence: Found['confidence'] = {};
  const warnings: string[] = [];
  const set = <K extends keyof ExtractedFields>(key: K, value: ExtractedFields[K], how: FieldConfidence = 'found') => {
    if (value === null || value === undefined) return;
    fields[key] = value;
    confidence[key] = how;
  };
  const ownVat = new Set((own.vat_ids ?? []).map(compact));
  const ownIban = new Set((own.ibans ?? []).map(compact));
  const ownNames = (own.names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const isOwnName = (line: string) => ownNames.some((n) => line.toLowerCase().includes(n));

  if (/\b(?:gutschrift|credit\s+note|rechnungskorrektur|storno)\b/i.test(text)) {
    fields.document_type = 'credit_note';
    warnings.push('This reads as a credit note, not an invoice — it is money owed to you');
  }

  // The supplier's IBAN: the first whose check digits hold and which is not ours.
  const ibanCandidates = [...text.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g)].map((m) => compact(m[0]));
  const validIbans = ibanCandidates.filter((c) => ibanValid(c) && !ownIban.has(c));
  set('iban', validIbans[0] ?? null);
  if (validIbans.length === 0 && ibanCandidates.some((c) => !ownIban.has(c) && /^[A-Z]{2}\d{2}/.test(c) && c.length >= 15)) {
    warnings.push('An IBAN is printed but its check digits do not hold — type it from the invoice and compare');
  }
  if (new Set(validIbans).size > 1) warnings.push('The invoice names more than one bank account — the first one was taken');
  set('bic', LABEL.bic.exec(text)?.[1] ?? null);

  // VAT ID: a labelled one first, else any well-formed one that is not ours.
  const vatCandidates: string[] = [];
  for (const line of lines) {
    const label = LABEL.vatId.exec(line);
    const m = VAT_ID.exec(label ? line.slice(label.index) : line);
    if (m) vatCandidates.push(compact(m[1]!).replace(/[.-]/g, ''));
  }
  set('supplier_vat_id', vatCandidates.find((v) => !ownVat.has(v)) ?? null);

  set(
    'invoice_number',
    afterLabel(lines, LABEL.number, (s) => {
      const m = INVOICE_NO.exec(s.trim());
      // A number has a digit in it; "Rechnungsnummer bitte angeben" is not one.
      return m && /\d/.test(m[1]!) ? m[1]!.replace(/[.,]$/, '') : null;
    }),
  );
  // "Date" alone also prefixes the due date and the date of supply.
  set('issue_date', afterLabel(lines, LABEL.issue, firstDate, new RegExp(`${LABEL.due.source}|leistungs|liefer|service\\s+date|delivery\\s+date`, 'i')));
  set('due_date', afterLabel(lines, LABEL.due, firstDate));
  if (!fields.due_date) {
    // "zahlbar innerhalb von 14 Tagen" — a term, not a date: derived from the issue date.
    const days = /\b(?:innerhalb\s+(?:von\s+)?|within\s+|net\s+|netto\s+)(\d{1,3})\s*(?:tagen|tage|days)\b|\b(\d{1,3})\s*(?:tage|days)\s+(?:netto|net)\b/i.exec(text);
    if (days && fields.issue_date) {
      const d = new Date(`${fields.issue_date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + Number(days[1] ?? days[2]));
      set('due_date', d.toISOString().slice(0, 10), 'derived');
    }
  }
  set(
    'po_number',
    afterLabel(lines, LABEL.po, (s) => {
      const m = /^([A-Z0-9][A-Z0-9\-\/]{2,39})/i.exec(s.trim());
      return m && /\d/.test(m[1]!) ? m[1]! : null;
    }) ?? /\bPO-\d{4}-\d{4}\b/.exec(text)?.[0] ?? null,
  );

  // Amounts: the last amount on a labelled line. Line items carry amounts
  // too, so only a label says which one is the total.
  const lastAmount = (re: RegExp, exclude?: RegExp) => {
    let value: number | null = null;
    for (const line of lines) {
      if (!re.test(line) || (exclude && exclude.test(line))) continue;
      const amounts = amountsIn(line);
      if (amounts.length > 0) value = amounts.at(-1)!;
    }
    return value;
  };
  let gross: number | null = null;
  for (const re of LABEL.gross) {
    gross = lastAmount(re, LABEL.net);
    if (gross !== null) break;
  }
  const net = lastAmount(LABEL.net);
  let tax = lastAmount(LABEL.taxTotal);
  if (tax === null) {
    // One line per rate ("USt 20 % von 1.200,00 … 240,00"): their sum.
    const perRate = lines
      .filter((l) => LABEL.tax.test(l) && !LABEL.vatId.test(l) && !VAT_ID.test(l) && !LABEL.net.test(l) && !LABEL.gross.some((g) => g.test(l)))
      .map((l) => amountsIn(l).at(-1))
      .filter((v): v is number => v !== undefined);
    if (perRate.length > 0) tax = perRate.reduce((a, b) => a + b, 0);
  }
  set('gross_cents', gross);
  set('net_cents', net);
  set('tax_cents', tax);
  if (gross === null && net !== null && tax !== null) set('gross_cents', net + tax, 'derived');
  if (net === null && gross !== null && tax !== null) set('net_cents', gross - tax, 'derived');
  if (tax === null && gross !== null && net !== null) set('tax_cents', gross - net, 'derived');

  const currency = /\b(EUR|CHF|USD|GBP|CZK|HUF|PLN|SEK|DKK|NOK)\b/.exec(text)?.[1] ?? (text.includes('€') ? 'EUR' : null);
  set('currency', currency);

  // The supplier's name: the first line carrying a legal form that is not ours.
  const nameLine = lines.find((l) => LEGAL_FORM.test(l) && !isOwnName(l) && !LABEL.vatId.test(l));
  if (nameLine) {
    const part = nameLine.split(/\s{2,}|\s[·|•–-]\s|,\s/).find((p) => LEGAL_FORM.test(p)) ?? nameLine;
    set('supplier_name', part.trim().slice(0, 200), 'guess');
  }

  return { fields, confidence, warnings };
}

export function emptyFields(): ExtractedFields {
  return {
    document_type: 'invoice',
    supplier_name: null,
    supplier_vat_id: null,
    iban: null,
    bic: null,
    invoice_number: null,
    issue_date: null,
    due_date: null,
    currency: null,
    net_cents: null,
    tax_cents: null,
    gross_cents: null,
    payable_cents: null,
    po_number: null,
    payment_reference: null,
  };
}
