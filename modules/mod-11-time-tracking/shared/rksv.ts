/**
 * The machine-readable code on an Austrian cash receipt (RKSV) — what an
 * expense receipt says about itself, read exactly, without a model.
 *
 * Every receipt a registered Austrian till prints carries it as a QR code
 * (Registrierkassensicherheitsverordnung § 10 Abs. 2 Z 12 and the BMF's
 * Detailspezifikation). Its text is thirteen fields after a leading `_`:
 *
 *   _R1-AT1_<Kassen-ID>_<Belegnummer>_<Beleg-Datum-Uhrzeit>
 *   _<Betrag-Satz-Normal>_<Betrag-Satz-Ermaessigt-1>_<Betrag-Satz-Ermaessigt-2>
 *   _<Betrag-Satz-Null>_<Betrag-Satz-Besonders>
 *   _<Stand-Umsatz-Zaehler-AES256-ICM>_<Zertifikat-Seriennummer>
 *   _<Sig-Voriger-Beleg>_<Signatur>
 *
 * as the BMF's reference implementation builds it
 * (a-sit-plus/at-registrierkassen-mustercode, ReceiptRepresentationForSignature
 * and CashBoxUtils.getQRCodeRepresentationFromJWSCompactRepresentation): the
 * date as `yyyy-MM-dd'T'HH:mm:ss`, each amount with Java's German number
 * format — two decimals, a comma, and a point grouping thousands (`1.234,56`)
 * — and the signature in standard base64.
 *
 * The amounts are GROSS per VAT rate. Which rate each field means is § 10
 * UStG: 20 %, 10 %, 13 %, 0 % — and "besonders", 19 % (Jungholz and
 * Mittelberg, § 10 Abs. 4 UStG). From 1 July 2026 the 4,9 % rate on certain
 * foods is entered in that same field (BMF, "Detailfragen zur RKSV", March
 * 2026), so from then on "besonders" is 4,9 % or 19 % and the receipt alone
 * does not say which: `special_rate_ambiguous` tells the caller to ask.
 *
 * A training receipt ("TRA") or a cancellation ("STO") is not a purchase; a
 * receipt printed while the signature device was down still is, and says so.
 */

export const RKSV_SPECIAL_AMBIGUOUS_FROM = '2026-07-01';

/** Rates in basis points (2000 = 20 %), keyed by field. */
export const RKSV_RATES = { normal: 2000, reduced1: 1000, reduced2: 1300, zero: 0 } as const;

export interface RksvAmounts {
  normal: number;
  reduced1: number;
  reduced2: number;
  zero: number;
  special: number;
}

export interface RksvReceipt {
  suite: string;
  cashbox_id: string;
  receipt_id: string;
  /** Local Austrian time as printed: YYYY-MM-DDTHH:MM:SS. */
  issued_at: string;
  /** Gross amounts per rate, in cents. */
  amounts: RksvAmounts;
  total_cents: number;
  /** "Sicherheitseinrichtung ausgefallen" — the till's signature device was down. */
  signature_failed: boolean;
  /** Not a purchase: a training receipt or a cancellation. */
  kind: 'sale' | 'training' | 'cancellation';
  /** From 1 July 2026 the special field is 4,9 % or 19 %; the receipt does not say which. */
  special_rate_ambiguous: boolean;
}

export class RksvError extends Error {}

// base64("Sicherheitseinrichtung ausgefallen"), the value a till writes as
// signature while its device is out of order.
const DEVICE_FAILED = 'U2ljaGVyaGVpdHNlaW5yaWNodHVuZyBhdXNnZWZhbGxlbg==';
// The turnover counter is replaced by base64 "TRA" / "STO" on those receipts.
const TRAINING = 'VFJB';
const CANCELLATION = 'U1RP';

const AMOUNT = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}$/;

/** `1.234,56` → 123456 cents, exactly. */
export function parseRksvAmount(text: string): number {
  if (!AMOUNT.test(text)) throw new RksvError(`"${text}" is not an amount as the receipt code writes it (1.234,56)`);
  const negative = text.startsWith('-');
  const [whole, cents] = text.replace(/^-/, '').replace(/\./g, '').split(',') as [string, string];
  const value = Number(whole) * 100 + Number(cents);
  if (!Number.isSafeInteger(value)) throw new RksvError(`"${text}" is out of range`);
  return negative ? -value : value;
}

function validDateTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60 && se < 60;
}

/** Read the code's text, or throw RksvError saying why it is not one. */
export function parseRksv(raw: string): RksvReceipt {
  const text = raw.trim();
  if (!text.startsWith('_R')) throw new RksvError('This is not the code of an Austrian cash receipt (it starts with "_R1-AT…")');
  const fields = text.slice(1).split('_');
  if (fields.length !== 13) throw new RksvError(`A receipt code has 13 fields; this one has ${fields.length}`);
  const [suite, cashboxId, receiptId, issuedAt, normal, reduced1, reduced2, zero, special, turnover, , , signature] = fields as [
    string, string, string, string, string, string, string, string, string, string, string, string, string,
  ];
  if (!/^R1-AT\d{1,3}$/.test(suite)) throw new RksvError(`Unknown algorithm suite "${suite}"`);
  if (!cashboxId || !receiptId) throw new RksvError('The code names no till or no receipt number');
  if (!validDateTime(issuedAt)) throw new RksvError(`"${issuedAt}" is not the receipt's date and time`);
  const amounts: RksvAmounts = {
    normal: parseRksvAmount(normal),
    reduced1: parseRksvAmount(reduced1),
    reduced2: parseRksvAmount(reduced2),
    zero: parseRksvAmount(zero),
    special: parseRksvAmount(special),
  };
  const kind = turnover === TRAINING ? 'training' : turnover === CANCELLATION ? 'cancellation' : 'sale';
  return {
    suite,
    cashbox_id: cashboxId,
    receipt_id: receiptId,
    issued_at: issuedAt,
    amounts,
    total_cents: amounts.normal + amounts.reduced1 + amounts.reduced2 + amounts.zero + amounts.special,
    signature_failed: signature === DEVICE_FAILED,
    kind,
    special_rate_ambiguous: amounts.special !== 0 && issuedAt.slice(0, 10) >= RKSV_SPECIAL_AMBIGUOUS_FROM,
  };
}

/**
 * The receipt's VAT lines: gross per rate in basis points. `specialRate` is
 * 1900 or 490 — 19 % always before July 2026; from then the person says.
 */
export function rksvVatLines(receipt: RksvReceipt, specialRate: 1900 | 490 = receipt.special_rate_ambiguous ? 490 : 1900): { rate_bp: number; gross_cents: number }[] {
  const lines = [
    { rate_bp: RKSV_RATES.normal, gross_cents: receipt.amounts.normal },
    { rate_bp: RKSV_RATES.reduced1, gross_cents: receipt.amounts.reduced1 },
    { rate_bp: RKSV_RATES.reduced2, gross_cents: receipt.amounts.reduced2 },
    { rate_bp: RKSV_RATES.zero, gross_cents: receipt.amounts.zero },
    { rate_bp: receipt.issued_at.slice(0, 10) >= RKSV_SPECIAL_AMBIGUOUS_FROM ? specialRate : 1900, gross_cents: receipt.amounts.special },
  ];
  return lines.filter((l) => l.gross_cents !== 0);
}
