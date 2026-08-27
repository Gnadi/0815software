import { at, attrOf, childrenOf, findAll, parse, textOf, type XmlElement } from './ebics/xml.js';

/**
 * `camt.053`, `camt.052` and `camt.054` — the bank's record of an account,
 * read into bookings.
 *
 * ## Why this lives in the platform service
 *
 * It did not, and the reason it did not is written down in
 * `docs/PLATFORM-SERVICE-OPPORTUNITIES.md`: a statement was stored whole and
 * handed over, because turning bookings into matched receivables is the
 * business of the module that has the invoices.
 *
 * That boundary was drawn one step too far out. **Reading a camt.053 is not
 * receivables matching** — it is understanding the format the bank speaks,
 * which is the one thing this service exists to do. A parser in every module
 * that wants bank data is the same mistake as an EBICS client in every module
 * that wants a bank, in a smaller and more insidious form: the versions differ,
 * the traps are invisible, and each copy gets them wrong differently.
 *
 * So this file reads the message. What a booking MEANS — which invoice it
 * settles, whether a customer is now paid up — stays with the module that
 * holds the invoices. The line is between *format* and *meaning*, and it is
 * the same line `payload.ts` draws on the way out.
 *
 * ## Written against the schemas, and why that mattered
 *
 * `test/schema/camt.053.001.02.xsd` and `…08.xsd` are vendored, and the
 * fixtures are validated against them before anything here parses them. Three
 * differences between those two versions are invisible in a sample file and
 * silent when got wrong:
 *
 * 1. **`Ntry/Sts`** is a plain code in `.02` and a `Cd`/`Prtry` choice in
 *    `.08`.
 * 2. **`RltdPties/Dbtr`** holds the name at `Dbtr/Nm` in `.02` and at
 *    `Dbtr/Pty/Nm` in `.08` — a reader written for one returns *no
 *    counterparty at all* on the other, which reads as "the bank did not send
 *    it".
 * 3. **`EntryTransaction`** has no transaction-level `Amt` in `.02`; the
 *    amount is under `AmtDtls/TxAmt/Amt`. In `.08` both exist.
 *
 * ## Amounts
 *
 * The exact decimal string the bank wrote is always kept. Beside it is
 * `amountHundredths` — the amount multiplied by exactly one hundred — and
 * **not** a field called `amountMinor`.
 *
 * That is deliberate. "Minor units" needs the currency's exponent, which is
 * two for the euro, zero for the yen and three for the dinar. Shipping that
 * table means transcribing ISO 4217 from memory, and this repository has been
 * bitten twice by exactly that kind of plausible transcription. A consumer
 * working in euros uses `amountHundredths` as cents and is right; a consumer
 * working in yen sees a name that does not promise them anything.
 *
 * Null when the bank wrote more than two decimal places, because rounding an
 * amount silently is worse than declining to convert it.
 */

/**
 * The three account messages, and what differs between them.
 *
 * **Their entries are the same structure — verified, not assumed.** The
 * Austrian schemas define `ReportEntry2` and `EntryTransaction2` in all three
 * files, and the definitions are identical element for element. That is why
 * one reader serves all three, and why this service declined to claim `camt.052`
 * and `camt.054` until those schemas were in hand: the structure being shared
 * is obvious, plausible, and worth nothing until checked.
 *
 * What actually differs is the two container names and one omission:
 * a notification carries no `Bal`, because there is no balance to report on a
 * list of individual items.
 */
const MESSAGES = {
  '053': { kind: 'statement', envelope: 'BkToCstmrStmt', container: 'Stmt' },
  '052': { kind: 'report', envelope: 'BkToCstmrAcctRpt', container: 'Rpt' },
  '054': { kind: 'notification', envelope: 'BkToCstmrDbtCdtNtfctn', container: 'Ntfctn' },
} as const satisfies Record<string, { kind: AccountMessageKind; envelope: string; container: string }>;

const NS_PREFIX = 'urn:iso:std:iso:20022:tech:xsd:camt.';

/**
 * Which of the three a document is.
 *
 *   statement     camt.053 — the end-of-day record. The definitive one.
 *   report        camt.052 — intraday, PROVISIONAL. The same booking appears
 *                 again in the day's statement, so summing both double-counts.
 *   notification  camt.054 — individual items, typically as they happen.
 */
export type AccountMessageKind = 'statement' | 'report' | 'notification';

/** One booking on an account. */
export interface StatementEntry {
  /** Position in the file, 1-based — the only stable identity an entry has. */
  seq: number;
  /** Exactly as the bank wrote it, unsigned. ISO puts the sign in `credit`. */
  amount: string;
  /** The amount times one hundred. Null above two decimal places. See above. */
  amountHundredths: number | null;
  currency: string;
  /** True when money came IN. `CdtDbtInd` — never a sign on the amount. */
  credit: boolean;
  /** True when this entry reverses an earlier one; do not double-count it. */
  reversal: boolean;
  /** `BOOK` booked, `PDNG` pending, `INFO` informational. */
  status: string;
  bookingDate: string | null;
  valueDate: string | null;
  entryRef: string | null;
  /** The bank's own reference for the booking. */
  accountServicerRef: string | null;
  /**
   * The ISO domain code as `Domn/Fmly/SubFmly`, e.g. `PMNT/RCDT/ESCT`.
   *
   * Null where a bank sends only its own code.
   */
  bankTransactionCode: string | null;
  /**
   * The bank's OWN transaction code, from `BkTxCd/Prtry/Cd`.
   *
   * Kept beside the ISO one rather than as a fallback for it. The Austrian
   * schemas make **both** `Domn` and `Prtry` mandatory, so an Austrian bank
   * always sends both — and a reader that preferred the ISO code and fell back
   * to this one would drop the proprietary code on every single booking, in
   * the market where it is the code the bank actually keys on.
   */
  proprietaryTransactionCode: string | null;
  /** The reference OUR pain.001 put on the transaction, when there is one. */
  endToEndId: string | null;
  mandateId: string | null;
  /** The MsgId of the file this booking came from — ours, on an outgoing one. */
  msgId: string | null;
  paymentInfoId: string | null;
  instructionId: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  /**
   * A COLLECTIVE booking, when the bank sent one — several payments in a
   * single entry on the account.
   *
   * Null for the ordinary case of one entry, one payment.
   *
   * When this is set, the reference and counterparty fields above are **null
   * on purpose**. They describe an individual transaction inside the batch,
   * not the entry, and an earlier version of this reader exposed the first
   * one as though it belonged to the whole amount: a €10,000 collective credit
   * covering forty customers was reported as a €10,000 payment from the first
   * of them, quoting the first one's invoice number. A consumer matching on
   * that gets the strongest possible evidence for a conclusion that is wrong
   * about thirty-nine fortieths of the money.
   */
  batch: {
    /** How many payments the entry covers, as the bank stated or counted. */
    count: number;
    /** `Btch/MsgId` — the file the batch came from, when named. */
    messageId: string | null;
    paymentInfoId: string | null;
  } | null;
  /** `RmtInf/Ustrd`, every line joined with a newline. */
  remittance: string | null;
  /**
   * `RmtInf/Strd/CdtrRefInf/Ref` — the structured creditor reference.
   *
   * The field an invoice number belongs in, and the one worth matching on
   * before falling back to reading free text.
   */
  creditorReference: string | null;
  purpose: string | null;
  /** Why a payment came back, when it did. */
  returnReason: string | null;
  additionalInfo: string | null;
}

/** A balance the statement reports. */
export interface StatementBalance {
  /** `OPBD` opening, `CLBD` closing, `PRCD` previous closing, … */
  type: string;
  amount: string;
  currency: string;
  credit: boolean;
  date: string | null;
}

/** One account's statement. A camt.053 may carry several. */
export interface AccountStatement {
  /** `Stmt/Id` — the bank's identifier for this statement. */
  statementId: string;
  electronicSequence: number | null;
  legalSequence: number | null;
  createdAt: string | null;
  fromDate: string | null;
  toDate: string | null;
  account: {
    iban: string | null;
    /** A non-IBAN account identifier, where the bank sends one. */
    other: string | null;
    currency: string | null;
    name: string | null;
    owner: string | null;
  };
  balances: StatementBalance[];
  entries: StatementEntry[];
}

/** What one account document said. */
export interface BankStatement {
  /** Which of the three messages this was. See `AccountMessageKind`. */
  kind: AccountMessageKind;
  /** The ISO message name, e.g. "camt.053.001.02". */
  messageName: string;
  /** The schema version, e.g. "02" or "08" — worth recording, they differ. */
  version: string;
  messageId: string;
  createdAt: string | null;
  statements: AccountStatement[];
}

/** True when the BTF names one of the three account messages. */
export function isAccountMessage(msgName: string): boolean {
  const name = msgName.toLowerCase();
  return name.startsWith('camt.053') || name.startsWith('camt.052') || name.startsWith('camt.054');
}

/** True when the BTF names the definitive end-of-day statement specifically. */
export function isStatementMessage(msgName: string): boolean {
  return msgName.toLowerCase().startsWith('camt.053');
}

/**
 * Read a camt.052, camt.053 or camt.054, or null when the bytes are none of
 * them.
 *
 * Null rather than a throw, for the reason every reader in this service gives:
 * the bytes are already stored, and refusing to continue would abandon a file
 * mid-fetch that the bank believes it has delivered.
 */
export function readBankStatement(content: Buffer): BankStatement | null {
  let root: XmlElement;
  try {
    root = parse(content.toString('utf8'));
  } catch {
    return null;
  }
  if (root.uri === null || !root.uri.startsWith(NS_PREFIX)) return null;

  // "052.001.02" → the message, then its version.
  const rest = root.uri.slice(NS_PREFIX.length);
  const match = /^(05[234])\.001\.(\d{2})$/.exec(rest);
  if (match === null) return null;
  const message = MESSAGES[match[1] as keyof typeof MESSAGES];

  const ns = root.uri;
  const body = at(root, ns, message.envelope);
  if (body === null) return null;
  const header = at(body, ns, 'GrpHdr');

  return {
    kind: message.kind,
    messageName: `camt.${rest}`,
    version: match[2] as string,
    messageId: header === null ? '' : textOf(at(header, ns, 'MsgId')).trim(),
    createdAt: header === null ? null : blank(textOf(at(header, ns, 'CreDtTm'))),
    statements: childrenOf(body, ns, message.container).map((stmt) => readStatement(stmt, ns)),
  };
}

function readStatement(stmt: XmlElement, ns: string): AccountStatement {
  const account = at(stmt, ns, 'Acct');
  const period = at(stmt, ns, 'FrToDt');
  const owner = account === null ? null : at(account, ns, 'Ownr');

  return {
    statementId: textOf(at(stmt, ns, 'Id')).trim(),
    electronicSequence: numberOr(textOf(at(stmt, ns, 'ElctrncSeqNb'))),
    legalSequence: numberOr(textOf(at(stmt, ns, 'LglSeqNb'))),
    // Required in .02, OPTIONAL in .08 — so an absent one is not a defect.
    createdAt: blank(textOf(at(stmt, ns, 'CreDtTm'))),
    fromDate: period === null ? null : blank(textOf(at(period, ns, 'FrDtTm'))),
    toDate: period === null ? null : blank(textOf(at(period, ns, 'ToDtTm'))),
    account: {
      iban: account === null ? null : blank(textOf(at(account, ns, 'Id', 'IBAN'))),
      other: account === null ? null : blank(textOf(at(account, ns, 'Id', 'Othr', 'Id'))),
      currency: account === null ? null : blank(textOf(at(account, ns, 'Ccy'))),
      name: account === null ? null : blank(textOf(at(account, ns, 'Nm'))),
      owner: owner === null ? null : partyName(owner, ns),
    },
    balances: childrenOf(stmt, ns, 'Bal').map((bal) => ({
      // Tp/CdOrPrtry/Cd in every version; Prtry where a bank uses its own.
      type: blank(textOf(at(bal, ns, 'Tp', 'CdOrPrtry', 'Cd'))) ??
        blank(textOf(at(bal, ns, 'Tp', 'CdOrPrtry', 'Prtry'))) ?? '',
      amount: textOf(at(bal, ns, 'Amt')).trim(),
      currency: attr(at(bal, ns, 'Amt'), 'Ccy') ?? '',
      credit: textOf(at(bal, ns, 'CdtDbtInd')).trim() === 'CRDT',
      date: dateOf(at(bal, ns, 'Dt'), ns),
    })),
    entries: childrenOf(stmt, ns, 'Ntry').map((entry, index) => readEntry(entry, ns, index + 1)),
  };
}

function readEntry(entry: XmlElement, ns: string, seq: number): StatementEntry {
  const amount = at(entry, ns, 'Amt');
  const raw = textOf(amount).trim();

  // How many payments this entry covers.
  //
  // NOT flattened into separate bookings: the ENTRY is what hit the account,
  // and inventing one booking per underlying transaction would double the
  // money for anything that sums them. But a batch's per-transaction fields
  // are equally not the entry's — see `batch` on StatementEntry — so they are
  // read only when there is exactly one transaction to read them from.
  const allDetails = childrenOf(entry, ns, 'NtryDtls').flatMap((d) => childrenOf(d, ns, 'TxDtls'));
  const batchInfo = at(entry, ns, 'NtryDtls', 'Btch');
  const statedCount = batchInfo === null ? null : numberOr(textOf(at(batchInfo, ns, 'NbOfTxs')));
  // A bank may state the count without repeating every transaction, so trust
  // the larger of what it said and what it sent.
  const count = Math.max(statedCount ?? 0, allDetails.length);
  const batched = count > 1;
  const details = batched ? null : (allDetails[0] ?? null);
  const refs = details === null ? null : at(details, ns, 'Refs');
  const parties = details === null ? null : at(details, ns, 'RltdPties');
  const remittance = details === null ? null : at(details, ns, 'RmtInf');
  const returnInfo = details === null ? null : at(details, ns, 'RtrInf');

  // Money IN means the counterparty is the DEBTOR; money out, the creditor.
  const credit = textOf(at(entry, ns, 'CdtDbtInd')).trim() === 'CRDT';
  const counterparty = parties === null ? null : at(parties, ns, credit ? 'Dbtr' : 'Cdtr');
  const counterpartyAccount = parties === null ? null : at(parties, ns, credit ? 'DbtrAcct' : 'CdtrAcct');

  return {
    seq,
    amount: raw,
    amountHundredths: hundredths(raw),
    currency: attr(amount, 'Ccy') ?? '',
    credit,
    reversal: textOf(at(entry, ns, 'RvslInd')).trim() === 'true',
    status: statusOf(entry, ns),
    bookingDate: dateOf(at(entry, ns, 'BookgDt'), ns),
    valueDate: dateOf(at(entry, ns, 'ValDt'), ns),
    entryRef: blank(textOf(at(entry, ns, 'NtryRef'))),
    accountServicerRef: blank(textOf(at(entry, ns, 'AcctSvcrRef'))),
    bankTransactionCode: isoTransactionCode(at(entry, ns, 'BkTxCd'), ns),
    proprietaryTransactionCode: proprietaryCode(at(entry, ns, 'BkTxCd'), ns),
    endToEndId: refs === null ? null : blank(textOf(at(refs, ns, 'EndToEndId'))),
    mandateId: refs === null ? null : blank(textOf(at(refs, ns, 'MndtId'))),
    msgId: refs === null ? null : blank(textOf(at(refs, ns, 'MsgId'))),
    paymentInfoId: refs === null ? null : blank(textOf(at(refs, ns, 'PmtInfId'))),
    instructionId: refs === null ? null : blank(textOf(at(refs, ns, 'InstrId'))),
    counterpartyName: counterparty === null ? null : partyName(counterparty, ns),
    counterpartyIban: counterpartyAccount === null ? null : blank(textOf(at(counterpartyAccount, ns, 'Id', 'IBAN'))),
    batch: batched
      ? {
          count,
          messageId: batchInfo === null ? null : blank(textOf(at(batchInfo, ns, 'MsgId'))),
          paymentInfoId: batchInfo === null ? null : blank(textOf(at(batchInfo, ns, 'PmtInfId'))),
        }
      : null,
    remittance: remittanceText(remittance, ns),
    creditorReference:
      remittance === null ? null : blank(textOf(at(remittance, ns, 'Strd', 'CdtrRefInf', 'Ref'))),
    purpose: details === null ? null : blank(textOf(at(details, ns, 'Purp', 'Cd'))),
    returnReason:
      returnInfo === null
        ? null
        : blank(textOf(at(returnInfo, ns, 'Rsn', 'Cd'))) ?? blank(textOf(at(returnInfo, ns, 'Rsn', 'Prtry'))),
    additionalInfo: blank(textOf(at(entry, ns, 'AddtlNtryInf'))),
  };
}

/**
 * `Ntry/Sts` — a plain code in `.02`, a `Cd`/`Prtry` choice in `.08`.
 *
 * Checked in that order rather than taking the element's text, because an
 * element's text is the concatenation of its descendants: `<Sts><Cd>BOOK</Cd>
 * </Sts>` happens to yield "BOOK", but `<Sts><Prtry>X</Prtry></Sts>` would too,
 * and a future third child would silently join in.
 */
function statusOf(entry: XmlElement, ns: string): string {
  const status = at(entry, ns, 'Sts');
  if (status === null) return '';
  const code = at(status, ns, 'Cd') ?? at(status, ns, 'Prtry');
  return code === null ? textOf(status).trim() : textOf(code).trim();
}

/**
 * A party's name, across the version break.
 *
 * `.02` puts it at `Nm`; `.08` wraps the party in a `Party40Choice`, so it is
 * at `Pty/Nm`. A reader that knows only one of those returns null on the other
 * — for EVERY booking, and without any error. This is the single most likely
 * silent failure in this file.
 */
function partyName(party: XmlElement, ns: string): string | null {
  return blank(textOf(at(party, ns, 'Nm'))) ?? blank(textOf(at(party, ns, 'Pty', 'Nm')));
}

/** `BookgDt`/`ValDt`/`Dt` are all a `Dt`-or-`DtTm` choice. */
function dateOf(node: XmlElement | null, ns: string): string | null {
  if (node === null) return null;
  return blank(textOf(at(node, ns, 'Dt'))) ?? blank(textOf(at(node, ns, 'DtTm')));
}

/** The ISO domain code as `Domn/Fmly/SubFmly`. */
function isoTransactionCode(node: XmlElement | null, ns: string): string | null {
  if (node === null) return null;
  const domain = at(node, ns, 'Domn');
  if (domain === null) return null;
  const family = at(domain, ns, 'Fmly');
  const parts = [
    textOf(at(domain, ns, 'Cd')).trim(),
    family === null ? '' : textOf(at(family, ns, 'Cd')).trim(),
    family === null ? '' : textOf(at(family, ns, 'SubFmlyCd')).trim(),
  ].filter((p) => p !== '');
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * The bank's own transaction code.
 *
 * Read separately, NOT as a fallback for the ISO one — see the note on
 * `proprietaryTransactionCode`. In Austria both are always present, so a
 * fallback would never fire and the proprietary code would be lost every time.
 */
function proprietaryCode(node: XmlElement | null, ns: string): string | null {
  return node === null ? null : blank(textOf(at(node, ns, 'Prtry', 'Cd')));
}

/**
 * Every unstructured remittance line, joined.
 *
 * `Ustrd` repeats — banks split a long reference across lines at 140
 * characters, so keeping only the first loses the second half of an invoice
 * number. Joined with a newline rather than concatenated, because whether the
 * split was mid-word is not knowable from here.
 */
function remittanceText(node: XmlElement | null, ns: string): string | null {
  if (node === null) return null;
  const lines = childrenOf(node, ns, 'Ustrd')
    .map((line) => textOf(line).trim())
    .filter((line) => line !== '');
  if (lines.length > 0) return lines.join('\n');
  // Some banks put everything in the structured block's free-text field.
  const additional = findAll(node, (n) => n.uri === ns && n.local === 'AddtlRmtInf')
    .map((line) => textOf(line).trim())
    .filter((line) => line !== '');
  return additional.length > 0 ? additional.join('\n') : null;
}

/**
 * The amount times one hundred, exactly — or null.
 *
 * String arithmetic rather than `Number(raw) * 100`, because that is floating
 * point: `19.99 * 100` is `1998.9999999999998`, and rounding it is the kind of
 * fix that works on every test amount and loses a cent on a real one.
 */
export function hundredths(raw: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (match === null) return null;
  const decimals = (match[2] ?? '').padEnd(2, '0');
  const value = Number(`${match[1]}${decimals}`);
  return Number.isSafeInteger(value) ? value : null;
}

function attr(node: XmlElement | null, name: string): string | null {
  return node === null ? null : attrOf(node, name);
}

function numberOr(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function blank(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}
