import { at, findAll, parse, textOf, type XmlElement } from './ebics/xml.js';

/**
 * Reading what the bank sent back about a payment.
 *
 * The same posture as `payload.ts` on the way out: read as little as possible,
 * and never rewrite. A `pain.002` payment status report is the one download
 * whose contents this service has to understand, because it is the answer to
 * "did that file go through?" — the question MOD-04 asks and cannot answer
 * from anything it holds.
 *
 * A `camt.053` statement is deliberately NOT parsed here. It is an account
 * statement, not an answer about an order, and matching bookings to invoices
 * is a module's business (receivables reconciliation, MOD-04's other
 * direction). This service stores it whole and hands it over; inventing a
 * booking model here would be the read-model service this repository decided
 * not to build.
 *
 * Everything below returns what it could read. A file it cannot parse yields
 * no reports rather than an exception: the bytes are already stored, the bank
 * is the authority on their validity, and refusing to store a file we could
 * not parse would lose the one copy we are ever offered.
 */

const PAIN_NS_PREFIX = 'urn:iso:std:iso:20022:tech:xsd:';

/** One payment's fate, as a pain.002 states it. */
export interface StatusReport {
  /** The original pain.001 `MsgId` this is about, when the file names one. */
  msgId: string | null;
  /**
   * The ISO 20022 status code. The ones that matter here:
   *
   *   ACCP / ACTC / ACSP  accepted, in progress — not yet money moved
   *   ACSC                settlement completed — the money moved
   *   RJCT                rejected
   *   PDNG                pending
   *
   * Passed through rather than translated, for the same reason `codes.ts`
   * stops at three EBICS codes: a confidently-worded wrong meaning next to a
   * payment is worse than no meaning.
   */
  statusCode: string;
  reasonCode: string | null;
  reason: string | null;
}

/** True when the BTF says this download is a payment status report. */
export function isStatusReport(msgName: string): boolean {
  return msgName.toLowerCase().startsWith('pain.002');
}

/**
 * Pull the payment statuses out of a pain.002.
 *
 * A report can carry a status for the whole group, for a payment-information
 * block, and for individual transactions. All three are collected, most
 * specific last, so a caller folding them in order ends on the finest-grained
 * answer the bank gave.
 */
export function readStatusReports(content: Buffer): StatusReport[] {
  let root: XmlElement;
  try {
    root = parse(content.toString('utf8'));
  } catch {
    return [];
  }
  if (root.uri === null || !root.uri.startsWith(PAIN_NS_PREFIX)) return [];

  const ns = root.uri;
  const body = at(root, ns, 'CstmrPmtStsRpt');
  if (body === null) return [];

  // The MsgId of the ORIGINAL file, and ONLY that — it is the handle an order
  // was filed under.
  //
  // There used to be a fallback to this report's own `GrpHdr/MsgId`, which is
  // the bank's id for the report and has nothing to do with any order. It
  // matched nothing in the usual case, and on a collision would have applied a
  // stranger's verdict to a real payment. A report that does not name the file
  // it is about is better left unattached: it is still stored, and a human can
  // read it.
  const originalMsgId = nullIfEmpty(textOf(at(body, ns, 'OrgnlGrpInfAndSts', 'OrgnlMsgId')).trim());

  const reports: StatusReport[] = [];
  const push = (node: XmlElement, statusTag: string): void => {
    const status = nullIfEmpty(textOf(at(node, ns, statusTag)).trim());
    if (status === null) return;
    const info = at(node, ns, 'StsRsnInf');
    reports.push({
      msgId: originalMsgId,
      statusCode: status,
      reasonCode: info === null ? null : nullIfEmpty(textOf(at(info, ns, 'Rsn', 'Cd')).trim()),
      reason: info === null ? null : nullIfEmpty(textOf(at(info, ns, 'AddtlInf')).trim()),
    });
  };

  const group = at(body, ns, 'OrgnlGrpInfAndSts');
  if (group !== null) push(group, 'GrpSts');
  for (const block of findAll(body, (n) => n.uri === ns && n.local === 'OrgnlPmtInfAndSts')) {
    push(block, 'PmtInfSts');
    for (const tx of findAll(block, (n) => n.uri === ns && n.local === 'TxInfAndSts')) {
      push(tx, 'TxSts');
    }
  }

  return reports;
}

/**
 * What a set of status codes means for the order they are about.
 *
 * Deliberately conservative in one direction: **any** rejection makes the
 * whole thing rejected, even alongside acceptances. A file where three
 * transfers went through and one bounced is not "accepted" from the point of
 * view of somebody who has to go and pay that fourth supplier.
 */
export type ReportVerdict = 'settled' | 'accepted' | 'rejected' | 'pending' | 'unknown';

export function verdictOfReports(reports: StatusReport[]): ReportVerdict {
  if (reports.length === 0) return 'unknown';
  const codes = reports.map((r) => r.statusCode.toUpperCase());
  if (codes.includes('RJCT')) return 'rejected';
  if (codes.includes('ACSC')) return 'settled';
  if (codes.some((c) => ['ACCP', 'ACTC', 'ACSP', 'ACWC'].includes(c))) return 'accepted';
  if (codes.includes('PDNG')) return 'pending';
  return 'unknown';
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value;
}
