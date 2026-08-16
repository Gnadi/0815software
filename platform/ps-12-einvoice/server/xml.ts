/**
 * Minimal XML writer and reader — zero dependencies, fully offline.
 *
 * Scope is deliberately tiny, and shaped by what UN/CEFACT CII actually needs:
 * namespaced elements in a FIXED order, attributes, text content, no mixed
 * content, no CDATA, no processing instructions beyond the declaration, no
 * DTDs, no entity declarations. That is the whole of an EN 16931 invoice.
 *
 * Order is the reason this is a tree of arrays rather than a plain object. CII
 * elements are declared in an xsd:sequence, so `<ram:Name>` before
 * `<ram:PostalTradeAddress>` is valid and the reverse is not — a schema
 * validator at the recipient rejects it. An object's key order is an
 * implementation detail of whoever built it; an array's is the author's intent.
 *
 * The reader exists for the inbound direction (parsing an invoice somebody sent
 * us) and is deliberately NOT a general XML parser: it refuses DOCTYPE outright
 * rather than trying to process it safely. Entity expansion in a document from
 * an unknown sender is the billion-laughs and XXE surface, and the honest way
 * to not have that surface is to not implement the feature.
 */

// ── Writing ────────────────────────────────────────────────────────────

/** An element: name, optional attributes, and either text or children. */
export interface XmlNode {
  name: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: XmlNode[];
}

/** `el('ram:ID', 'INV-1')` · `el('ram:X', [child])` · `el('ram:X', 'v', {a: 'b'})` */
export function el(
  name: string,
  content?: string | number | XmlNode[] | null,
  attrs?: Record<string, string>,
): XmlNode {
  if (content === null || content === undefined) return { name, attrs };
  if (Array.isArray(content)) return { name, attrs, children: content };
  return { name, attrs, text: String(content) };
}

/**
 * Escape text for an XML text node or attribute value.
 *
 * All five predefined entities, always — including `>` and `'`, which are only
 * conditionally required. A conditional escape is a rule someone has to get
 * right at every call site; escaping unconditionally is a rule nobody can get
 * wrong, and the extra bytes are free.
 *
 * Characters XML 1.0 forbids outright (the C0 controls other than tab, CR and
 * LF) are DROPPED rather than escaped, because there is no escape that makes
 * them legal — `&#x1;` is as invalid as the raw byte. A customer name carrying
 * a stray control character then yields a valid document instead of one every
 * parser rejects.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderNode(node: XmlNode, indent: string): string[] {
  const attrs = Object.entries(node.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  if (node.children && node.children.length > 0) {
    return [
      `${indent}<${node.name}${attrs}>`,
      ...node.children.flatMap((child) => renderNode(child, `${indent}  `)),
      `${indent}</${node.name}>`,
    ];
  }
  if (node.text !== undefined) return [`${indent}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`];
  return [`${indent}<${node.name}${attrs}/>`];
}

/**
 * Render a document. Deterministic to the byte: the same input always produces
 * the same output, which is what lets a test assert on a whole document and
 * what lets a hash over the XML mean something.
 */
export function renderXml(root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderNode(root, '').join('\n')}\n`;
}

// ── Reading ────────────────────────────────────────────────────────────

export interface ParsedElement {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: ParsedElement[];
}

export class XmlParseError extends Error {}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Resolve the five predefined entities and numeric character references. */
function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    // An UNKNOWN entity is returned as written rather than resolved. There is
    // no entity table to consult, because a DOCTYPE — the only way to declare
    // one — is refused below.
    return ENTITIES[body] ?? match;
  });
}

/**
 * Parse an XML document into a tree.
 *
 * Refuses a DOCTYPE rather than ignoring it. A document from an unknown sender
 * is exactly where entity expansion turns into billion-laughs or XXE, and
 * declining the feature is the only way to be certain neither is reachable —
 * far more convincing than a limit on how many entities may expand.
 */
export function parseXml(source: string, { maxBytes = 8 * 1024 * 1024 } = {}): ParsedElement {
  if (source.length > maxBytes) throw new XmlParseError(`document exceeds ${maxBytes} bytes`);
  if (/<!DOCTYPE/i.test(source)) {
    throw new XmlParseError('DOCTYPE is not accepted — external entities are refused, not sandboxed');
  }

  const stack: ParsedElement[] = [];
  let root: ParsedElement | null = null;
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) {
      const text = source.slice(i, lt);
      if (stack.length > 0 && text.trim() !== '') stack[stack.length - 1]!.text += unescapeXml(text);
    }

    if (source.startsWith('<?', lt) || source.startsWith('<!--', lt)) {
      const close = source.indexOf(source.startsWith('<?', lt) ? '?>' : '-->', lt);
      if (close === -1) throw new XmlParseError('unterminated declaration or comment');
      i = close + (source.startsWith('<?', lt) ? 2 : 3);
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt);
      if (close === -1) throw new XmlParseError('unterminated CDATA section');
      if (stack.length > 0) stack[stack.length - 1]!.text += source.slice(lt + 9, close);
      i = close + 3;
      continue;
    }

    const gt = source.indexOf('>', lt);
    if (gt === -1) throw new XmlParseError('unterminated tag');
    const raw = source.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const open = stack.pop();
      if (!open) throw new XmlParseError(`closing tag </${name}> with nothing open`);
      if (open.name !== name) throw new XmlParseError(`</${name}> closes <${open.name}>`);
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const inner = selfClosing ? raw.slice(0, -1).trim() : raw;
    const spaceAt = inner.search(/\s/);
    const name = spaceAt === -1 ? inner : inner.slice(0, spaceAt);
    if (name === '') throw new XmlParseError('empty tag name');

    const attrs: Record<string, string> = {};
    if (spaceAt !== -1) {
      const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(inner.slice(spaceAt))) !== null) {
        attrs[m[1] ?? m[3]!] = unescapeXml(m[2] ?? m[4] ?? '');
      }
    }

    const node: ParsedElement = { name, attrs, text: '', children: [] };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    else if (root === null) root = node;
    else throw new XmlParseError('document has more than one root element');
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  if (stack.length > 0) throw new XmlParseError(`unclosed <${stack[stack.length - 1]!.name}>`);
  if (root === null) throw new XmlParseError('document has no root element');
  return root;
}

/** Strip the namespace prefix: "ram:ID" → "ID". */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Direct children matching a local name, ignoring the namespace prefix. */
export function childrenNamed(node: ParsedElement, local: string): ParsedElement[] {
  return node.children.filter((child) => localName(child.name) === local);
}

/** The first descendant along a path of local names, or null. */
export function at(node: ParsedElement, ...path: string[]): ParsedElement | null {
  let current: ParsedElement | undefined = node;
  for (const step of path) {
    current = childrenNamed(current!, step)[0];
    if (!current) return null;
  }
  return current ?? null;
}

/** Trimmed text at a path, or null when the path does not exist. */
export function textAt(node: ParsedElement, ...path: string[]): string | null {
  const found = at(node, ...path);
  return found ? found.text.trim() : null;
}
