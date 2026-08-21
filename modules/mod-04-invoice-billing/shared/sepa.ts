/**
 * SEPA CREDIT TRANSFER — the pain.001 file a bank actually accepts.
 *
 * This is the whole of the bank-file knowledge in this module: IBAN/BIC
 * validation, the SEPA character set, and one renderer for
 * **pain.001.001.03**, the ISO 20022 customer credit transfer initiation that
 * Austrian and German online banking accepts as a file upload (the payload an
 * MBS/EBICS channel carries; see the module README for why this module stops
 * at the file).
 *
 * Three rules make it safe to hand the output to a bank:
 *
 * 1. **The file is a document, not a view.** Nothing here reads the database
 *    or the clock: `buildPain001` is a pure function of its input, so the same
 *    payment run always renders byte-identical XML. A bank rejects a second
 *    file with a known `MsgId`, and an operator who downloads twice must get
 *    the file they already uploaded — not a new one that differs in a
 *    timestamp.
 * 2. **Money is integer cents until the last moment.** Amounts are formatted
 *    once, in `sepaAmount`, as the two-decimal string the schema demands. The
 *    control sums are computed from the same integers the transactions carry,
 *    so `CtrlSum` can never be a rounding of a rounding.
 * 3. **Only characters the scheme allows ever reach the file.** The SEPA
 *    character set is a subset of Latin-1 (`sepaText`); a supplier called
 *    "Müller & Söhne" becomes "Mueller + Soehne" deterministically rather than
 *    being rejected by the bank's file check, or — worse — silently paid to a
 *    mangled name.
 *
 * The file this produces is a valid pain.001.001.03 message per the ISO 20022
 * schema and the EPC implementation guidelines. Banks nevertheless differ in
 * what they accept (some insist on a BIC, some cap the batch size, some
 * require a specific `ReqdExctnDt` lead time). Run one file through your
 * bank's file check before the first live upload — the same honesty the ERP
 * export profiles in MOD-06 carry.
 */

/** The ISO 20022 message this module writes. */
export const PAIN_NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03';
export const PAIN_VERSION = 'pain.001.001.03';

/** Field lengths the schema imposes. Text longer than these is truncated. */
export const MAX_MESSAGE_ID = 35;
export const MAX_END_TO_END_ID = 35;
export const MAX_NAME = 70;
export const MAX_REMITTANCE = 140;

/** The scheme is euro-only; the field makes that explicit rather than implied. */
export const SEPA_CURRENCY = 'EUR';

/**
 * The largest amount a SEPA credit transfer may carry: 999,999,999.99 EUR.
 * A bank rejects anything above it, so this module refuses it first — with a
 * message naming the limit instead of an XSD error from the upload form.
 */
export const MAX_AMOUNT_CENTS = 99_999_999_999;

/**
 * IBAN length per SEPA scheme country. The map is the country filter as well
 * as the length check: an IBAN whose country is not in the scheme area cannot
 * be paid by a SEPA credit transfer at all, and saying so at entry is far
 * cheaper than a bank rejecting the file after the operator has stopped
 * looking at it.
 */
export const SEPA_IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18,
  EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28,
  IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31,
  NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
  VA: 22,
};

/** Strip spaces and case: the form an IBAN is stored and compared in. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** "AT61 1904 3002 3457 3201" — grouped in fours, how humans read it back. */
export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * ISO 7064 MOD 97-10 over a string of digits and letters (A = 10 … Z = 35),
 * folded in chunks so no intermediate value leaves the safe integer range.
 */
function mod97(input: string): number {
  let remainder = 0;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      remainder = (remainder * 100 + (code - 55)) % 97;
    } else {
      return -1; // a character that has no numeric value — never valid
    }
  }
  return remainder;
}

/**
 * Why an IBAN is unusable, or null when it is fine. A message rather than a
 * boolean because every caller shows it to whoever typed the IBAN, and
 * "invalid" tells them nothing about which half they got wrong.
 */
export function ibanProblem(raw: string): string | null {
  const iban = normalizeIban(raw);
  if (iban === '') return 'IBAN is required';
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return 'IBAN must start with two letters and two check digits, followed by letters and digits only';
  }
  const country = iban.slice(0, 2);
  const expected = SEPA_IBAN_LENGTHS[country];
  if (expected === undefined) {
    return `${country} is not a SEPA scheme country — a SEPA credit transfer cannot reach this account`;
  }
  if (iban.length !== expected) {
    return `An ${country} IBAN has ${expected} characters, this one has ${iban.length}`;
  }
  if (mod97(iban.slice(4) + iban.slice(0, 4)) !== 1) {
    return 'IBAN check digits do not match — check for a typo';
  }
  return null;
}

export function isValidIban(raw: string): boolean {
  return ibanProblem(raw) === null;
}

/** 8 or 11 characters: bank (4 letters), country (2), location (2), branch (3). */
const BIC_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export function normalizeBic(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function isValidBic(raw: string): boolean {
  return BIC_RE.test(normalizeBic(raw));
}

/**
 * ISO 11649 creditor reference ("RF…"), the structured alternative to a free
 * text payment purpose. When a supplier prints one on their invoice, quoting
 * it back structurally is what lets their accounting software match the
 * payment automatically — so `buildPain001` puts a valid one in `Strd` rather
 * than burying it in `Ustrd`.
 */
export function isCreditorReference(raw: string): boolean {
  const ref = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^RF[0-9]{2}[A-Z0-9]{1,21}$/.test(ref)) return false;
  return mod97(ref.slice(4) + ref.slice(0, 4)) === 1;
}

/**
 * The SEPA character set: `a–z A–Z 0–9 / - ? : ( ) . , ' +` and space.
 *
 * Anything else has to go, and *how* it goes is a decision with money behind
 * it: the creditor name in the file is what the receiving bank shows next to
 * the transfer, so it must still read as the supplier's name. The mapping is
 * therefore transliteration first (German umlauts and ß the way the DACH
 * banking world writes them, then any remaining accent dropped by Unicode
 * decomposition), and only what survives that becomes a space.
 *
 * `&` is the one deliberate substitution: it is not in the set, it is
 * extremely common in company names, and `+` is the convention every bank
 * form suggests for it.
 */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss',
  æ: 'ae', Æ: 'Ae', ø: 'oe', Ø: 'Oe', å: 'aa', Å: 'Aa',
  '&': '+', '"': "'", '„': "'", '“': "'", '”': "'", '‘': "'", '’': "'",
  '–': '-', '—': '-', '_': '-', '€': 'EUR', '№': 'Nr',
};

const ALLOWED_RE = /[^A-Za-z0-9/\-?:().,'+ ]/g;

/**
 * Render text as the SEPA character set, collapsed and truncated to `max`.
 * Returns an empty string when nothing survives — callers decide what to put
 * in the field instead, because a blank creditor name is not a payment.
 */
export function sepaText(raw: string, max: number): string {
  const substituted = [...raw].map((ch) => TRANSLITERATIONS[ch] ?? ch).join('');
  // NFD splits "é" into "e" + combining accent; dropping the marks leaves the
  // base letter, which is what a bank form does with a pasted foreign name.
  const stripped = substituted.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return stripped.replace(ALLOWED_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** Integer cents as the schema's decimal string: 123456 → "1234.56". */
export function sepaAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ── The document ──────────────────────────────────────────────────────

/** One credit transfer: who gets paid, how much, and what for. */
export interface SepaCreditTransfer {
  /** Reconciliation handle, echoed back on the bank statement. ≤ 35 chars. */
  end_to_end_id: string;
  amount_cents: number;
  creditor_name: string;
  creditor_iban: string;
  /** Omitted from the file when null — SEPA is IBAN-only within the EEA. */
  creditor_bic: string | null;
  /** The payment purpose. An ISO 11649 "RF…" reference is sent structurally. */
  remittance: string;
}

/** One payment run: one debtor account, one execution date, N transfers. */
export interface SepaInstruction {
  /** `GrpHdr/MsgId` — unique per file, and the bank's duplicate check. */
  message_id: string;
  /** `GrpHdr/CreDtTm` — an ISO 8601 timestamp, frozen when the run was made. */
  created_at: string;
  /** `ReqdExctnDt` — "YYYY-MM-DD", the day the bank should execute. */
  execution_date: string;
  /**
   * `BtchBookg`. False — one statement line per payment, each carrying its own
   * `EndToEndId`, which is what makes the payments reconcilable one by one.
   * True would book the run as a single sum: tidier statement, no paper trail.
   */
  batch_booking: boolean;
  debtor_name: string;
  debtor_iban: string;
  debtor_bic: string | null;
  payments: SepaCreditTransfer[];
}

export interface SepaProblem {
  field: string;
  message: string;
}

/** Sum of the transfers, in cents — what `CtrlSum` must equal. */
export function sepaControlSum(payments: { amount_cents: number }[]): number {
  return payments.reduce((total, p) => total + p.amount_cents, 0);
}

/**
 * Validate an instruction as the bank's file check would: identifiers present
 * and short enough, IBANs real, amounts positive integers within the scheme
 * limit, at least one payment. Returns an empty array when the file is safe to
 * build — the caller turns anything else into a 422 with the fields named.
 *
 * Deliberately NOT best-effort: the alternative to refusing a bad instruction
 * is writing a file the bank refuses, at a point where the operator has
 * already left the screen.
 */
export function validateSepaInstruction(instruction: SepaInstruction): SepaProblem[] {
  const problems: SepaProblem[] = [];
  const push = (field: string, message: string): void => void problems.push({ field, message });

  if (instruction.message_id.trim() === '') push('message_id', 'is required');
  if (instruction.message_id.length > MAX_MESSAGE_ID) {
    push('message_id', `must be at most ${MAX_MESSAGE_ID} characters`);
  }
  if (Number.isNaN(Date.parse(instruction.created_at))) {
    push('created_at', 'must be an ISO 8601 timestamp');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(instruction.execution_date)) {
    push('execution_date', 'must be a date in YYYY-MM-DD format');
  }
  if (sepaText(instruction.debtor_name, MAX_NAME) === '') {
    push('debtor_name', 'is required — the bank prints it as the payer');
  }
  const debtorIban = ibanProblem(instruction.debtor_iban);
  if (debtorIban) push('debtor_iban', debtorIban);
  if (instruction.debtor_bic !== null && !isValidBic(instruction.debtor_bic)) {
    push('debtor_bic', 'must be a valid 8 or 11 character BIC');
  }

  if (instruction.payments.length === 0) {
    push('payments', 'a payment run needs at least one transfer');
  }
  instruction.payments.forEach((payment, i) => {
    const at = (field: string): string => `payments[${i}].${field}`;
    if (payment.end_to_end_id.trim() === '') push(at('end_to_end_id'), 'is required');
    if (payment.end_to_end_id.length > MAX_END_TO_END_ID) {
      push(at('end_to_end_id'), `must be at most ${MAX_END_TO_END_ID} characters`);
    }
    if (!Number.isInteger(payment.amount_cents) || payment.amount_cents <= 0) {
      push(at('amount_cents'), 'must be a positive integer amount in cents');
    } else if (payment.amount_cents > MAX_AMOUNT_CENTS) {
      push(at('amount_cents'), `must not exceed ${sepaAmount(MAX_AMOUNT_CENTS)} EUR in one transfer`);
    }
    if (sepaText(payment.creditor_name, MAX_NAME) === '') {
      push(at('creditor_name'), 'is required, and must contain at least one SEPA character');
    }
    const iban = ibanProblem(payment.creditor_iban);
    if (iban) push(at('creditor_iban'), iban);
    if (payment.creditor_bic !== null && !isValidBic(payment.creditor_bic)) {
      push(at('creditor_bic'), 'must be a valid 8 or 11 character BIC');
    }
  });

  return problems;
}

// ── Rendering ─────────────────────────────────────────────────────────

/** XML text escaping. Redundant after `sepaText`, and kept anyway. */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tag(indent: number, name: string, value: string): string {
  return `${' '.repeat(indent)}<${name}>${xml(value)}</${name}>`;
}

/**
 * The agent (bank) block. SEPA has been IBAN-only since 2016, so an unknown
 * BIC is not a missing field: for the creditor the element is left out
 * entirely, and for the debtor — where the schema makes it mandatory — the
 * scheme's own `NOTPROVIDED` placeholder says "look it up from the IBAN"
 * rather than inventing a bank code.
 */
function agent(indent: number, name: 'DbtrAgt' | 'CdtrAgt', bic: string | null): string[] {
  const pad = ' '.repeat(indent);
  if (bic === null) {
    if (name === 'CdtrAgt') return [];
    return [
      `${pad}<${name}>`,
      `${pad}  <FinInstnId>`,
      `${pad}    <Othr>`,
      `${pad}      <Id>NOTPROVIDED</Id>`,
      `${pad}    </Othr>`,
      `${pad}  </FinInstnId>`,
      `${pad}</${name}>`,
    ];
  }
  return [
    `${pad}<${name}>`,
    `${pad}  <FinInstnId>`,
    tag(indent + 4, 'BIC', normalizeBic(bic)),
    `${pad}  </FinInstnId>`,
    `${pad}</${name}>`,
  ];
}

/**
 * The payment purpose. A valid ISO 11649 reference goes into the structured
 * block as `SCOR`, which is what the creditor's accounting system reads to
 * match the payment automatically; everything else is unstructured text.
 */
function remittance(indent: number, text: string): string[] {
  const pad = ' '.repeat(indent);
  const trimmed = text.trim();
  if (trimmed !== '' && isCreditorReference(trimmed)) {
    const ref = trimmed.replace(/\s+/g, '').toUpperCase();
    return [
      `${pad}<RmtInf>`,
      `${pad}  <Strd>`,
      `${pad}    <CdtrRefInf>`,
      `${pad}      <Tp>`,
      `${pad}        <CdOrPrtry>`,
      tag(indent + 10, 'Cd', 'SCOR'),
      `${pad}        </CdOrPrtry>`,
      `${pad}      </Tp>`,
      tag(indent + 6, 'Ref', ref),
      `${pad}    </CdtrRefInf>`,
      `${pad}  </Strd>`,
      `${pad}</RmtInf>`,
    ];
  }
  const ustrd = sepaText(text, MAX_REMITTANCE);
  if (ustrd === '') return [];
  return [`${pad}<RmtInf>`, tag(indent + 2, 'Ustrd', ustrd), `${pad}</RmtInf>`];
}

/**
 * Render the instruction as pain.001.001.03.
 *
 * Element order is fixed by the schema, not by taste — `CdtrAgt` before
 * `Cdtr`, `ChrgBr` after the debtor block — so this function writes it out
 * literally rather than assembling it from a map, where a reordered key would
 * produce a file that reads fine and fails the bank's XSD check.
 *
 * Call `validateSepaInstruction` first. This function renders what it is
 * given: it is the same discipline the PDF renderer follows, and it is what
 * makes the output a pure function of the stored payment run.
 */
export function buildPain001(instruction: SepaInstruction): string {
  const { payments } = instruction;
  const count = String(payments.length);
  const control = sepaAmount(sepaControlSum(payments));
  const paymentInfoId = `${instruction.message_id}-1`.slice(0, MAX_MESSAGE_ID);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Document xmlns="${PAIN_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    '  <CstmrCdtTrfInitn>',
    '    <GrpHdr>',
    tag(6, 'MsgId', instruction.message_id),
    tag(6, 'CreDtTm', instruction.created_at),
    tag(6, 'NbOfTxs', count),
    tag(6, 'CtrlSum', control),
    '      <InitgPty>',
    tag(8, 'Nm', sepaText(instruction.debtor_name, MAX_NAME)),
    '      </InitgPty>',
    '    </GrpHdr>',
    '    <PmtInf>',
    tag(6, 'PmtInfId', paymentInfoId),
    tag(6, 'PmtMtd', 'TRF'),
    tag(6, 'BtchBookg', instruction.batch_booking ? 'true' : 'false'),
    tag(6, 'NbOfTxs', count),
    tag(6, 'CtrlSum', control),
    '      <PmtTpInf>',
    '        <SvcLvl>',
    tag(10, 'Cd', 'SEPA'),
    '        </SvcLvl>',
    '      </PmtTpInf>',
    tag(6, 'ReqdExctnDt', instruction.execution_date),
    '      <Dbtr>',
    tag(8, 'Nm', sepaText(instruction.debtor_name, MAX_NAME)),
    '      </Dbtr>',
    '      <DbtrAcct>',
    '        <Id>',
    tag(10, 'IBAN', normalizeIban(instruction.debtor_iban)),
    '        </Id>',
    '      </DbtrAcct>',
    ...agent(6, 'DbtrAgt', instruction.debtor_bic),
    // SLEV — "following the service level", the only charge bearer a SEPA
    // credit transfer allows: each side pays its own bank's fees.
    tag(6, 'ChrgBr', 'SLEV'),
  ];

  for (const payment of payments) {
    lines.push(
      '      <CdtTrfTxInf>',
      '        <PmtId>',
      tag(10, 'EndToEndId', payment.end_to_end_id),
      '        </PmtId>',
      '        <Amt>',
      `          <InstdAmt Ccy="${SEPA_CURRENCY}">${sepaAmount(payment.amount_cents)}</InstdAmt>`,
      '        </Amt>',
      ...agent(8, 'CdtrAgt', payment.creditor_bic),
      '        <Cdtr>',
      tag(10, 'Nm', sepaText(payment.creditor_name, MAX_NAME)),
      '        </Cdtr>',
      '        <CdtrAcct>',
      '          <Id>',
      tag(12, 'IBAN', normalizeIban(payment.creditor_iban)),
      '          </Id>',
      '        </CdtrAcct>',
      ...remittance(8, payment.remittance),
      '      </CdtTrfTxInf>',
    );
  }

  lines.push('    </PmtInf>', '  </CstmrCdtTrfInitn>', '</Document>', '');
  return lines.join('\n');
}
