import { at, findAll, parse, textOf, type XmlElement } from './ebics/xml.js';

/**
 * `HAC` — the customer acknowledgement, or *Kundenprotokoll*.
 *
 * The bank's own log of what it did with every order: the file arrived, the
 * signature verified (or did not), it went into the distributed-signature
 * queue, a second subscriber signed it, it finished. The place to look when a
 * payment file goes quiet.
 *
 * ## The trap this file exists to avoid
 *
 * **A `HAC` document and a payment status report are both `pain.002.001.03`.**
 * Same namespace, same root element, same `CstmrPmtStsRpt`. Nothing about the
 * document's shape says which it is, and `reports.ts` — whose job is to read a
 * status report and settle or reject the order it names — would happily parse
 * one.
 *
 * The one thing that tells them apart is documented in the schema's own
 * annotation: `OrgnlGrpInfAndSts/OrgnlMsgId` and `OrgnlMsgNmId` are
 * "always constant EBICS" in a `HAC`, whereas a status report puts the
 * original file's `MsgId` there. So `isCustomerAcknowledgement` is checked
 * FIRST, everywhere a downloaded `pain.002` is classified, and a document that
 * says `EBICS` is never offered to `readStatusReports`.
 *
 * As it happens the current `HAC` profile omits `GrpSts`, `PmtInfSts` and
 * `TxSts` — the three elements `reports.ts` reads — so today it would come
 * back empty rather than wrong. That is luck, not design: a bank adding one of
 * them would attach a verdict carrying the msgId `"EBICS"` to whatever order
 * happened to be filed under that name.
 *
 * ## How an entry is shaped, and why it is read by key
 *
 * Each `OrgnlPmtInfAndSts` is one logged action. `OrgnlPmtInfId` is the action
 * keyword; the details are name/value pairs under
 * `StsRsnInf/Orgtr/Id/OrgId/Othr`, where `SchmeNm/Prtry` is the NAME and `Id`
 * is the value.
 *
 * Two things about those pairs, both from the published examples rather than
 * from reading the schema:
 *
 * 1. **They are unordered.** The examples say so in a comment: "There is no
 *    specific order defined for the element groups Othr". Reading them by
 *    position would work on one bank and not on the next.
 * 2. **The names are not consistently cased.** The EBICS Working Group's own
 *    example file uses `OrderID` twenty-one times and `OrderId` twice, in the
 *    same document. So lookup is case-insensitive. A case-sensitive reader
 *    would silently lose the order number on two of the entries in the very
 *    file published to demonstrate the format.
 */

const PAIN_002_003 = 'urn:iso:std:iso:20022:tech:xsd:pain.002.001.03';

/** The constant that marks a document as a customer acknowledgement. */
const HAC_MARKER = 'EBICS';

/**
 * The action keywords the published examples use.
 *
 * Passed through as read rather than mapped to an enum — a bank may log an
 * action this list does not know, and the whole point of a protocol is to be
 * readable when something unexpected happened.
 */
export type HacAction =
  | 'FILE_UPLOAD'
  | 'FILE_DOWNLOAD'
  | 'ES_UPLOAD'
  | 'ES_VERIFICATION'
  | 'VEU_FORWARDING'
  | 'VEU_VERIFICATION'
  | 'VEU_VERIFICATION_END'
  | 'ORDER_HAC_FINAL'
  | (string & {});

/** One logged action. */
export interface HacEntry {
  /** `FILE_UPLOAD`, `ES_VERIFICATION`, `ORDER_HAC_FINAL`, … */
  action: HacAction;
  /** The customer's name, as the bank holds it. */
  customerName: string | null;
  userId: string | null;
  partnerId: string | null;
  /**
   * The EBICS order number this action is about — the handle that ties a `HAC`
   * entry back to something this service submitted.
   */
  orderId: string | null;
  adminOrderType: string | null;
  serviceName: string | null;
  serviceOption: string | null;
  scope: string | null;
  msgName: string | null;
  /** ISO 8601, as the bank wrote it. */
  timestamp: string | null;
  /**
   * The ORIGINAL order, when this action is about another one.
   *
   * A `HVE` co-signature has its own order number and refers to the payment it
   * signs; the bank puts the payment's details in the `…Ref` keys. Without
   * this, a co-signature looks like an unrelated order.
   */
  references: {
    orderId: string | null;
    adminOrderType: string | null;
    serviceName: string | null;
    serviceOption: string | null;
    msgName: string | null;
  };
  /**
   * The ISO reason code: `TS01` transmitted, `DS01` signature valid,
   * `DS11` certificate revoked, …
   *
   * Passed through, not translated, for the reason `codes.ts` gives: a
   * confidently-worded wrong meaning beside a payment is worse than no meaning.
   * Absent on `ORDER_HAC_FINAL`, which is a marker rather than a result.
   */
  reasonCode: string | null;
  /**
   * Free text. On `ORDER_HAC_FINAL` this is where the bank puts the **display
   * file** — its own rendering of what the order contained.
   */
  additionalInfo: string | null;
}

/** What one `HAC` download said. */
export interface CustomerAcknowledgement {
  /** The bank's id for this protocol file. */
  messageId: string;
  createdAt: string;
  /** The bank system that wrote it, from `GrpHdr/InitgPty`. */
  hostId: string | null;
  entries: HacEntry[];
}

/**
 * True when these bytes are a customer acknowledgement rather than a payment
 * status report.
 *
 * Cheap and total: it parses, checks the namespace and reads one element. Call
 * it before anything else looks at a downloaded `pain.002`.
 */
export function isCustomerAcknowledgement(content: Buffer): boolean {
  const root = parseOrNull(content);
  if (root === null) return false;
  const group = at(root, PAIN_002_003, 'CstmrPmtStsRpt', 'OrgnlGrpInfAndSts');
  if (group === null) return false;
  return textOf(at(group, PAIN_002_003, 'OrgnlMsgId')).trim() === HAC_MARKER;
}

/** Read one, or null when the bytes are not a customer acknowledgement. */
export function readCustomerAcknowledgement(content: Buffer): CustomerAcknowledgement | null {
  const root = parseOrNull(content);
  if (root === null) return null;
  const body = at(root, PAIN_002_003, 'CstmrPmtStsRpt');
  if (body === null) return null;

  const group = at(body, PAIN_002_003, 'OrgnlGrpInfAndSts');
  if (group === null || textOf(at(group, PAIN_002_003, 'OrgnlMsgId')).trim() !== HAC_MARKER) return null;

  const header = at(body, PAIN_002_003, 'GrpHdr');
  return {
    messageId: header === null ? '' : textOf(at(header, PAIN_002_003, 'MsgId')).trim(),
    createdAt: header === null ? '' : textOf(at(header, PAIN_002_003, 'CreDtTm')).trim(),
    // The schema's annotation is explicit that only `Id/OrgId/Othr/Id` is used
    // here, and that it holds the HostID.
    hostId:
      header === null
        ? null
        : nullIfBlank(textOf(at(header, PAIN_002_003, 'InitgPty', 'Id', 'OrgId', 'Othr', 'Id'))),
    entries: findAll(body, (n) => n.uri === PAIN_002_003 && n.local === 'OrgnlPmtInfAndSts').map(readEntry),
  };
}

function readEntry(block: XmlElement): HacEntry {
  const info = at(block, PAIN_002_003, 'StsRsnInf');
  const originator = info === null ? null : at(info, PAIN_002_003, 'Orgtr');
  const org = originator === null ? null : at(originator, PAIN_002_003, 'Id', 'OrgId');

  // Case-insensitive, because the published examples are not consistent.
  const pairs = new Map<string, string>();
  if (org !== null) {
    for (const other of findAll(org, (n) => n.uri === PAIN_002_003 && n.local === 'Othr')) {
      const name = textOf(at(other, PAIN_002_003, 'SchmeNm', 'Prtry')).trim();
      if (name === '') continue;
      pairs.set(name.toLowerCase(), textOf(at(other, PAIN_002_003, 'Id')).trim());
    }
  }
  const value = (name: string): string | null => nullIfBlank(pairs.get(name.toLowerCase()) ?? '');

  return {
    action: textOf(at(block, PAIN_002_003, 'OrgnlPmtInfId')).trim(),
    customerName: originator === null ? null : nullIfBlank(textOf(at(originator, PAIN_002_003, 'Nm'))),
    userId: value('UserID'),
    partnerId: value('PartnerID'),
    orderId: value('OrderID'),
    adminOrderType: value('AdminOrderType'),
    serviceName: value('ServiceName'),
    serviceOption: value('ServiceOption'),
    scope: value('Scope'),
    msgName: value('MsgName'),
    timestamp: value('TimeStamp'),
    references: {
      orderId: value('OrderIDRef'),
      adminOrderType: value('AdminOrderTypeRef'),
      serviceName: value('ServiceNameRef'),
      serviceOption: value('ServiceOptionRef'),
      msgName: value('MsgNameRef'),
    },
    reasonCode: info === null ? null : nullIfBlank(textOf(at(info, PAIN_002_003, 'Rsn', 'Cd'))),
    additionalInfo: info === null ? null : nullIfBlank(textOf(at(info, PAIN_002_003, 'AddtlInf'))),
  };
}

/**
 * What the log says happened to one order, folded from its entries.
 *
 * `ORDER_HAC_FINAL` is the bank's end marker for an order: everything it meant
 * to do has been done. It carries no reason code of its own, so the verdict
 * comes from what was logged before it.
 *
 * The rule is the one `verdictOfReports` uses and for the same reason: **any
 * failure makes the order failed**, even beside successes. A file whose
 * signature was refused is not "processed" to somebody who has to go and pay
 * the supplier.
 */
export type HacVerdict = 'processed' | 'failed' | 'in_progress';

export function verdictOfEntries(entries: HacEntry[]): HacVerdict {
  if (entries.length === 0) return 'in_progress';
  // Success codes from the published examples: TS01 transmitted, DS01 ES
  // valid, DS05 EDS complete, DS06 forwarded to the EDS queue. Anything else
  // with a code is a failure — including DS11, a revoked certificate.
  const good = new Set(['TS01', 'DS01', 'DS05', 'DS06']);
  const failed = entries.some((e) => e.reasonCode !== null && !good.has(e.reasonCode.toUpperCase()));
  if (failed) return 'failed';
  return entries.some((e) => e.action === 'ORDER_HAC_FINAL') ? 'processed' : 'in_progress';
}

/** The entries about one EBICS order number, its `…Ref` mentions included. */
export function entriesForOrder(acknowledgement: CustomerAcknowledgement, orderId: string): HacEntry[] {
  return acknowledgement.entries.filter(
    (entry) => entry.orderId === orderId || entry.references.orderId === orderId,
  );
}

function parseOrNull(content: Buffer): XmlElement | null {
  let root: XmlElement;
  try {
    root = parse(content.toString('utf8'));
  } catch {
    return null;
  }
  return root.uri === PAIN_002_003 ? root : null;
}

function nullIfBlank(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}
