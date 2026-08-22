import { at, childrenOf, parse, textOf, type XmlElement } from './ebics/xml.js';

/**
 * The Austrian Customer Information Message.
 *
 * A bank-to-customer notice — a service window, a format deadline — fetched
 * with `CIM/AT` and, unlike a statement, meant to be read by a person rather
 * than reconciled. Without this it lands in `downloads` as `other`: kept,
 * offered, and completely opaque.
 *
 * ## The first version of this file was wrong
 *
 * It was written without the schema, from the implementation guideline's
 * prose, which says each customer information "`<CIMMsgType>`" carries a
 * timestamp and a `<CIMId>`. `CIMMsgType` is a **type** name. The element is
 * `CIM`. So the reader found nothing, fell back to treating the whole document
 * as one notice, and produced a single entry containing every scrap of text in
 * the file — the message id from the group header included.
 *
 * That is worth recording because the file went out of its way to avoid
 * exactly this: it took only names the guideline stated and read everything
 * else structurally, on the grounds that guessing `<CIMText>` would repeat an
 * old mistake. The ceiling was right and it did not save the file, because the
 * fallback path turned "I cannot read this" into a plausible wrong answer. A
 * schema is not a nicety here; it is the only thing that can tell the two
 * apart.
 *
 * Everything below now comes from `EBICS.CIM.Response.V.1.0.xsd`, vendored in
 * `test/schema/` and validated against in `cim.test.ts`.
 */

/** The namespace the published schema declares. */
export const CIM_NS = 'http://www.psa.at/EBICS/CIMResp';

/** One notice the bank has for this customer. */
export interface CustomerInfo {
  /** `CIMId` — an RFC 4122 UUID; the schema fixes it at 36 characters. */
  id: string;
  /** `CIMTmStmp` — when the CIM was created in the bank's host system. */
  timestamp: string;
  /** `HdLine` — optional, at most 82 characters, to be shown in bold. */
  headline: string | null;
  /**
   * `CIMTxt` — the message body, at most 1680 characters.
   *
   * **This is HTML and is not sanitised here.** The schema names the tags a
   * bank may use (`p`, `br`, `pre`, lists, `a href`, font attributes) and says
   * a client must ignore all others. Anything rendering this must escape or
   * sanitise it: it is a string from outside, and the fact that a bank sent it
   * makes it no safer to inject into a page.
   */
  text: string;
}

/** What one `CIMResp` document carries. */
export interface CustomerInfoMessage {
  /** `GrpHdr/MsgId` — timestamp plus random digits, 20–35 characters. */
  messageId: string;
  /** `GrpHdr/CreDtTm` — when the EBICS server built the message. */
  createdAt: string;
  notices: CustomerInfo[];
}

/** True when the BTF says this download is a customer information message. */
export function isCustomerInfo(msgName: string): boolean {
  const name = msgName.toLowerCase();
  // The mapping table says `cimresp`; the implementation guideline's worked
  // ebicsRequest example says `BRCResp`. Both are accepted — an operator whose
  // bank follows the older example should not get an opaque blob for it.
  return name === 'cimresp' || name === 'brcresp';
}

/**
 * Read a `CIMResp`.
 *
 * Returns null for anything that is not one, including bytes that are not XML.
 * The document is stored whole either way, so failing loudly here would only
 * turn an unreadable notice into an unreadable download — and a bank's service
 * announcement is not worth a 500.
 *
 * Elements are matched by local name rather than by namespace. The schema
 * declares one and a conforming bank will use it, but a notice is a thing to
 * read, not a payment to authorise: being lenient costs nothing here and a
 * namespace mismatch would otherwise hide the message entirely.
 */
export function readCustomerInfo(content: Buffer | string): CustomerInfoMessage | null {
  let root: XmlElement;
  try {
    root = parse(typeof content === 'string' ? content : content.toString('utf8'));
  } catch {
    return null;
  }
  if (root.local !== 'Document') return null;

  const header = firstNamed(root, 'GrpHdr');
  const notices = childrenNamed(root, 'CIM').map(readOne);
  // A CIMResp with no CIM at all is not one: the schema requires at least one.
  if (notices.length === 0) return null;

  return {
    messageId: header === null ? '' : textOf(firstNamed(header, 'MsgId')).trim(),
    createdAt: header === null ? '' : textOf(firstNamed(header, 'CreDtTm')).trim(),
    notices,
  };
}

function readOne(message: XmlElement): CustomerInfo {
  const headline = firstNamed(message, 'HdLine');
  return {
    id: textOf(firstNamed(message, 'CIMId')).trim(),
    timestamp: textOf(firstNamed(message, 'CIMTmStmp')).trim(),
    headline: headline === null ? null : blankToNull(textOf(headline)),
    // Not trimmed to nothing and not defaulted: an empty CIMTxt is a bank
    // sending an empty notice, which is different from one this cannot read.
    text: textOf(firstNamed(message, 'CIMTxt')),
  };
}

/** By local name, in the schema's namespace or any other. */
function childrenNamed(scope: XmlElement, local: string): XmlElement[] {
  const declared = childrenOf(scope, CIM_NS, local);
  if (declared.length > 0) return declared;
  return scope.children.filter((c): c is XmlElement => c.kind === 'element' && c.local === local);
}

function firstNamed(scope: XmlElement, local: string): XmlElement | null {
  return at(scope, CIM_NS, local) ?? childrenNamed(scope, local)[0] ?? null;
}

function blankToNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}
