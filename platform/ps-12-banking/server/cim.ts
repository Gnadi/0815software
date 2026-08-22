import { findAll, parse, textOf, type XmlElement } from './ebics/xml.js';

/**
 * The Austrian Customer Information Message.
 *
 * A bank-to-customer notice — a service window, a format change, a deadline —
 * fetched with `CIM/AT` and, unlike a statement, meant to be read by a person
 * rather than reconciled. Without this it lands in `downloads` as `other`:
 * kept, offered, and completely opaque.
 *
 * ## What this deliberately does NOT know
 *
 * **The CIMResp schema is not in this repository.** It is published at
 * `zv.psa.at`, which this build cannot reach. So the only element names used
 * here are the two the Austrian implementation guideline states in prose —
 * `CIMMsgType` for one message and `CIMId` for its RFC 4122 identifier — and
 * everything else is taken structurally:
 *
 * - the **text** is the element's own text content, which needs no name at all;
 * - a **timestamp** is any descendant whose text parses as an ISO date-time,
 *   because the guideline says each message carries one but does not name it;
 * - nothing is required, and nothing throws.
 *
 * That is a deliberate ceiling. Three earlier rounds of this service were
 * corrected by published documents, twice for element names invented from a
 * plausible reading, so a parser that guessed `<CIMText>` or `<Subject>` would
 * be repeating a mistake this codebase has already paid for. When the schema
 * arrives, this file gets stricter and the tests get more specific.
 *
 * ## The name the BTF uses
 *
 * The two Austrian documents disagree. The mapping table (04.07.2025) says
 * `MsgName` is **`cimresp`**; the implementation guideline's worked
 * `ebicsRequest` example says **`BRCResp`**. `isCustomerInfo` accepts either,
 * because an operator whose bank follows the older example should not get an
 * opaque blob for it — see `bank-registry.ts`, which records the conflict.
 */

/** One notice the bank has for this customer. */
export interface CustomerInfo {
  /** `CIMId` — an RFC 4122 UUID, when the message carries one. */
  id: string | null;
  /** The first ISO date-time found inside the message, if any. */
  timestamp: string | null;
  /** Every non-empty line of text in the message, in document order. */
  lines: string[];
}

/** True when the BTF says this download is a customer information message. */
export function isCustomerInfo(msgName: string): boolean {
  const name = msgName.toLowerCase();
  return name === 'cimresp' || name === 'brcresp';
}

/** An ISO 8601 date-time, loosely — enough to tell one from a subject line. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Read the notices out of a `CIMResp`.
 *
 * Returns an empty list for anything it cannot make sense of, including bytes
 * that are not XML at all. The document is stored whole either way, so failing
 * loudly here would only turn an unreadable notice into an unreadable
 * download — and a bank's marketing message is not worth a 500.
 */
export function readCustomerInfo(content: Buffer | string): CustomerInfo[] {
  let root: XmlElement;
  try {
    root = parse(typeof content === 'string' ? content : content.toString('utf8'));
  } catch {
    return [];
  }

  // By local name only: the guideline names the element but this build has no
  // schema to say which namespace it lives in, and guessing one would drop
  // every message from a bank that chose differently.
  const messages = findAll(root, (node) => node.local === 'CIMMsgType');
  // A response with a single message and no wrapper element still has to be
  // readable, so the root itself is the fallback.
  return (messages.length > 0 ? messages : [root]).map(readOne);
}

function readOne(message: XmlElement): CustomerInfo {
  const id = findAll(message, (node) => node.local === 'CIMId')[0];
  const lines = textLines(message);
  return {
    id: id === undefined ? null : nullIfBlank(textOf(id)),
    timestamp: lines.find((line) => ISO_DATE_TIME.test(line)) ?? null,
    // The id and the timestamp are text too; a reader wants the prose.
    lines: lines.filter((line) => !ISO_DATE_TIME.test(line) && line !== (id === undefined ? null : textOf(id).trim())),
  };
}

/**
 * Every non-empty text run under an element, one entry per element that has
 * text of its own.
 *
 * Per element rather than one concatenated blob, because a CIMResp holds an
 * optional heading and then the body, and running them together would lose the
 * only structure this can see without a schema.
 */
function textLines(node: XmlElement): string[] {
  const out: string[] = [];
  const own = node.children
    .filter((child): child is { kind: 'text'; value: string } => child.kind === 'text')
    .map((child) => child.value.trim())
    .filter((value) => value !== '');
  out.push(...own);
  for (const child of node.children) {
    if (child.kind === 'element') out.push(...textLines(child));
  }
  return out;
}

function nullIfBlank(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}
