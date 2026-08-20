/**
 * XML, canonical by construction — and a parser strict enough to verify one.
 *
 * EBICS signs XML, which means the bytes that get hashed are not the bytes on
 * the wire but their **exclusive canonical form** (`http://www.w3.org/2001/10/
 * xml-exc-c14n#`). Node has no canonicaliser, and this service may not add a
 * dependency, so this file is both halves of the problem — and it is the file
 * to be most careful in, because every signature in the protocol is a hash of
 * something it produced.
 *
 * The design turns the hard direction into the easy one:
 *
 * 1. **Writing is canonical by construction.** `render()` emits exclusive-C14N
 *    form directly — no comments, no XML declaration, empty elements as
 *    start+end tags, attributes in canonical order, namespaces declared exactly
 *    where they are visibly used, `&`/`<`/`>`/CR escaped in text and
 *    `&`/`<`/`"`/TAB/LF/CR in attribute values. When we sign our own document
 *    there is nothing to canonicalise: the digest is over the bytes we wrote.
 *    A bug in the *parser* therefore cannot produce a bad outgoing signature.
 * 2. **Reading exists only to check the bank.** `parse()` produces a tree that
 *    `canonicalize()` re-serialises through the same writer, which is what lets
 *    us verify the bank's `AuthSignature`. Round-tripping through one renderer
 *    is deliberate: there is a single definition of "canonical" here, and both
 *    directions are held to it.
 *
 * Every node carries a namespace two ways, and the distinction is load-bearing:
 * **`prefix` is presentation, `uri` is identity.** A bank that writes `ns2:` for
 * the namespace we write as `ebics:` produces a different document and the same
 * meaning; comparisons are always on `uri`, and canonicalising preserves the
 * document's own prefixes because a canonicaliser re-lays-out and renames
 * nothing.
 *
 * The parser handles what EBICS actually uses — elements, attributes,
 * namespaces, text, CDATA, comments, the declaration, the five predefined
 * entities and numeric character references. It **refuses** what it does not
 * implement (DTDs, processing instructions, custom entities) rather than
 * guessing, because a document this parser misreads is a document whose
 * signature we would verify against the wrong bytes.
 */

// ── The tree ──────────────────────────────────────────────────────────

export interface XmlAttr {
  /** The prefix as written, or '' for an unprefixed attribute. */
  prefix: string;
  local: string;
  /** Resolved namespace URI. Null for unprefixed: those are in NO namespace. */
  uri: string | null;
  value: string;
}

export interface XmlElement {
  kind: 'element';
  /** The prefix as written, or '' for the default namespace. */
  prefix: string;
  local: string;
  /** Resolved namespace URI. Null only for a document with no namespaces. */
  uri: string | null;
  attrs: XmlAttr[];
  children: XmlNode[];
}

export interface XmlText {
  kind: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

/** The namespaces a built document uses, as `prefix → uri`. */
export type NsMap = Readonly<Record<string, string>>;

export class XmlError extends Error {}

function splitName(name: string): [prefix: string, local: string] {
  const colon = name.indexOf(':');
  return colon === -1 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
}

// ── Building ──────────────────────────────────────────────────────────

/**
 * Build an element. Names are `prefix:local` or `local`; every prefix must
 * resolve in the namespace map given to `render`, so a typo fails when the
 * document is written rather than when the bank rejects it.
 *
 * `uri` is left null here and filled in by `render`, which is the only place
 * that holds the prefix→URI map for a built document.
 */
export function el(
  name: string,
  attrs: Record<string, string> = {},
  children: (XmlNode | string | null | undefined)[] = [],
): XmlElement {
  const [prefix, local] = splitName(name);
  return {
    kind: 'element',
    prefix,
    local,
    uri: null,
    attrs: Object.entries(attrs).map(([key, value]) => {
      const [attrPrefix, attrLocal] = splitName(key);
      return { prefix: attrPrefix, local: attrLocal, uri: null, value };
    }),
    children: children
      .filter((c): c is XmlNode | string => c !== null && c !== undefined)
      .map((c) => (typeof c === 'string' ? text(c) : c)),
  };
}

export function text(value: string): XmlText {
  return { kind: 'text', value };
}

// ── Escaping ──────────────────────────────────────────────────────────

/**
 * Canonical XML escapes less than you might expect, and the difference changes
 * the bytes that get hashed. In text: `&`, `<`, `>` and a literal CR. In
 * attribute values: `&`, `<`, `"` and the whitespace characters TAB, LF and CR
 * (an unescaped LF in an attribute is normalised away by any conformant parser,
 * so it has to survive as a reference). Apostrophes, and `>` inside attributes,
 * are left alone — escaping them would be valid XML and the wrong canonical form.
 */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

// ── Rendering (exclusive canonical form) ──────────────────────────────

/**
 * Resolve a prefix for rendering: a parsed node's own URI wins, otherwise the
 * namespace map a built document was handed.
 *
 * Null is a real answer, not a failure: an element can be in **no namespace**
 * at all (a document that never declares one), and so is every unprefixed
 * attribute. Only a non-empty prefix with nothing behind it is an error — that
 * is a typo, and it must surface here rather than as a bank rejection.
 */
function uriFor(prefix: string, own: string | null, ns: NsMap): string | null {
  if (own !== null) return own;
  const uri = ns[prefix];
  if (uri === undefined) {
    if (prefix === '') return null; // no default namespace: no namespace
    throw new XmlError(`no namespace declared for prefix "${prefix}" — add it to the namespace map`);
  }
  return uri;
}

interface Rendered {
  /** Serialised `xmlns` declarations this element must carry. */
  declarations: string[];
  /** Serialised ordinary attributes, in canonical order. */
  attributes: string[];
  /** What those declarations put in scope, for the children. */
  declared: Map<string, string>;
}

/**
 * Exclusive canonicalisation's central rule: an element declares a namespace
 * **only when it is visibly used** — by the element's own name or by one of its
 * attributes — and only when an ancestor has not already bound that prefix to
 * that URI. Visible use is the whole point of *exclusive* C14N: it is what lets
 * a signed fragment keep its digest when it is lifted into another document,
 * which is exactly what EBICS does with the authenticated parts of a request.
 */
function renderAttrs(node: XmlElement, ns: NsMap, inherited: Map<string, string>): Rendered {
  const declared = new Map<string, string>();

  const require = (prefix: string, own: string | null): string | null => {
    const uri = uriFor(prefix, own, ns);
    // Nothing to declare for "no namespace" unless an ancestor bound this
    // prefix to something else — then canonical form needs `xmlns=""` to
    // undeclare it, which is why the empty URI is a value and not an absence.
    if (uri === null) {
      if (inherited.has(prefix)) declared.set(prefix, '');
      return null;
    }
    if (inherited.get(prefix) !== uri) declared.set(prefix, uri);
    return uri;
  };

  require(node.prefix, node.uri);
  const attrUris = new Map<XmlAttr, string | null>();
  for (const attr of node.attrs) {
    // An unprefixed attribute is in NO namespace and needs no declaration.
    attrUris.set(attr, attr.prefix === '' ? null : require(attr.prefix, attr.uri));
  }

  const declarations = [...declared.entries()]
    // Canonical order: the default declaration first, then prefixes by name.
    .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0] < b[0] ? -1 : 1))
    .map(([prefix, uri]) =>
      prefix === '' ? ` xmlns="${escapeAttr(uri)}"` : ` xmlns:${prefix}="${escapeAttr(uri)}"`,
    );

  const attributes = [...node.attrs]
    // Canonical order: by namespace URI (no namespace sorts first), then local name.
    .sort((a, b) => {
      const aUri = attrUris.get(a) ?? '';
      const bUri = attrUris.get(b) ?? '';
      if (aUri !== bUri) return aUri < bUri ? -1 : 1;
      return a.local < b.local ? -1 : 1;
    })
    .map((attr) => {
      const name = attr.prefix === '' ? attr.local : `${attr.prefix}:${attr.local}`;
      return ` ${name}="${escapeAttr(attr.value)}"`;
    });

  return { declarations, attributes, declared };
}

function renderNode(node: XmlNode, ns: NsMap, inherited: Map<string, string>, out: string[]): void {
  if (node.kind === 'text') {
    out.push(escapeText(node.value));
    return;
  }

  const { declarations, attributes, declared } = renderAttrs(node, ns, inherited);
  const name = node.prefix === '' ? node.local : `${node.prefix}:${node.local}`;
  out.push(`<${name}`, ...declarations, ...attributes, '>');

  const scope = new Map(inherited);
  for (const [prefix, uri] of declared) scope.set(prefix, uri);
  for (const kid of node.children) renderNode(kid, ns, scope, out);

  // Canonical form has no self-closing tags: <X></X>, never <X/>.
  out.push(`</${name}>`);
}

/**
 * Serialise a tree in exclusive canonical form. This is THE definition of the
 * bytes this service signs and verifies — nothing else here turns a tree into
 * XML.
 */
export function render(root: XmlElement, ns: NsMap = {}): string {
  const out: string[] = [];
  renderNode(root, ns, new Map(), out);
  return out.join('');
}

/**
 * A whole document as it goes on the wire: the XML declaration — which is NOT
 * part of the canonical form, and therefore not part of any digest — followed
 * by the canonical root element.
 */
export function document(root: XmlElement, ns: NsMap = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, ns)}`;
}

/**
 * The exclusive canonical form of a PARSED element — the bytes a digest over
 * the bank's own XML must be taken of. Parsed nodes already carry their URIs,
 * so no namespace map is needed and no prefix is rewritten.
 */
export function canonicalize(node: XmlElement): string {
  return render(node);
}

// ── Parsing ───────────────────────────────────────────────────────────

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9._:-]/;

/** Resolve the five predefined entities and numeric character references. */
function unescape(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        throw new XmlError(`unsupported entity ${match} — this parser resolves no custom entities`);
    }
  });
}

interface ParseFrame {
  element: XmlElement;
  /** prefix → uri, declared here or inherited. */
  scope: Map<string, string>;
}

/** Parse a document into the same tree the writer consumes. */
export function parse(xml: string): XmlElement {
  let i = 0;
  const stack: ParseFrame[] = [];
  let root: XmlElement | null = null;

  const fail = (message: string): never => {
    throw new XmlError(`${message} at offset ${i}`);
  };

  const readName = (): string => {
    const start = i;
    if (i >= xml.length || !NAME_START.test(xml[i]!)) fail('expected a name');
    i++;
    while (i < xml.length && NAME_CHAR.test(xml[i]!)) i++;
    return xml.slice(start, i);
  };

  const skipSpace = (): void => {
    while (i < xml.length && /\s/.test(xml[i]!)) i++;
  };

  const push = (node: XmlNode): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) fail('content outside the root element');
    else top.element.children.push(node);
  };

  while (i < xml.length) {
    if (xml.startsWith('<?xml', i)) {
      const end = xml.indexOf('?>', i);
      if (end === -1) fail('unterminated XML declaration');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<?', i)) fail('processing instructions are not supported');
    if (xml.startsWith('<!DOCTYPE', i)) fail('DTDs are not supported');
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i);
      if (end === -1) fail('unterminated comment');
      i = end + 3; // comments are absent from canonical form: dropped, not kept
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i);
      if (end === -1) fail('unterminated CDATA section');
      push(text(xml.slice(i + 9, end)));
      i = end + 3;
      continue;
    }

    if (xml.startsWith('</', i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (xml[i] !== '>') fail('expected ">" closing an end tag');
      i++;
      const frame = stack.pop();
      if (frame === undefined) return fail(`unexpected end tag </${name}>`);
      const open = frame.element.prefix === '' ? frame.element.local : `${frame.element.prefix}:${frame.element.local}`;
      if (name !== open) fail(`end tag </${name}> does not match <${open}>`);
      if (stack.length === 0) root = frame.element;
      continue;
    }

    if (xml[i] === '<') {
      i++;
      const qname = readName();
      const [prefix, local] = splitName(qname);

      // Attributes first: a namespace declared on this element is in scope for
      // the element's own name, so the scope must be complete before resolving.
      const raw: { qname: string; value: string }[] = [];
      for (;;) {
        skipSpace();
        if (i >= xml.length) fail('unterminated start tag');
        if (xml[i] === '>' || xml.startsWith('/>', i)) break;
        const attrName = readName();
        skipSpace();
        if (xml[i] !== '=') fail('expected "=" in an attribute');
        i++;
        skipSpace();
        const quote = xml[i];
        if (quote !== '"' && quote !== "'") fail('expected a quoted attribute value');
        i++;
        const end = xml.indexOf(quote, i);
        if (end === -1) fail('unterminated attribute value');
        raw.push({ qname: attrName, value: unescape(xml.slice(i, end)) });
        i = end + 1;
      }

      const scope = new Map(stack.length > 0 ? stack[stack.length - 1]!.scope : []);
      for (const attr of raw) {
        if (attr.qname === 'xmlns') scope.set('', attr.value);
        else if (attr.qname.startsWith('xmlns:')) scope.set(attr.qname.slice(6), attr.value);
      }

      const resolve = (p: string, isAttr: boolean): string | null => {
        if (p === '') return isAttr ? null : (scope.get('') ?? null);
        const uri = scope.get(p);
        if (uri === undefined) throw new XmlError(`undeclared namespace prefix "${p}"`);
        return uri;
      };

      const element: XmlElement = {
        kind: 'element',
        prefix,
        local,
        uri: resolve(prefix, false),
        attrs: raw
          .filter((attr) => attr.qname !== 'xmlns' && !attr.qname.startsWith('xmlns:'))
          .map((attr) => {
            const [attrPrefix, attrLocal] = splitName(attr.qname);
            return { prefix: attrPrefix, local: attrLocal, uri: resolve(attrPrefix, true), value: attr.value };
          }),
        children: [],
      };

      if (stack.length > 0) stack[stack.length - 1]!.element.children.push(element);
      else if (root !== null) fail('a document may only have one root element');

      const selfClosing = xml.startsWith('/>', i);
      i += selfClosing ? 2 : 1;
      if (selfClosing) {
        if (stack.length === 0) root = element;
      } else {
        stack.push({ element, scope });
      }
      continue;
    }

    // Character data.
    const next = xml.indexOf('<', i);
    const chunk = xml.slice(i, next === -1 ? xml.length : next);
    if (stack.length === 0) {
      if (chunk.trim() !== '') fail('character data outside the root element');
    } else {
      push(text(unescape(chunk)));
    }
    i = next === -1 ? xml.length : next;
  }

  if (stack.length > 0) throw new XmlError(`unclosed element <${stack[stack.length - 1]!.element.local}>`);
  if (root === null) throw new XmlError('document has no root element');
  return root;
}

// ── Reading a parsed tree ─────────────────────────────────────────────

/** Direct children in a namespace with a local name. */
export function childrenOf(node: XmlElement, uri: string | null, local: string): XmlElement[] {
  return node.children.filter(
    (c): c is XmlElement => c.kind === 'element' && c.uri === uri && c.local === local,
  );
}

/** The first matching child, or null. */
export function child(node: XmlElement, uri: string | null, local: string): XmlElement | null {
  return childrenOf(node, uri, local)[0] ?? null;
}

/**
 * Follow a path of local names within one namespace. EBICS responses are deep
 * and narrow, so this is how nearly every value gets read.
 */
export function at(node: XmlElement, uri: string | null, ...path: string[]): XmlElement | null {
  let current: XmlElement | null = node;
  for (const step of path) {
    if (current === null) return null;
    current = child(current, uri, step);
  }
  return current;
}

/** All text under an element, concatenated — the value of a leaf. */
export function textOf(node: XmlElement | null): string {
  if (node === null) return '';
  let out = '';
  for (const item of node.children) out += item.kind === 'text' ? item.value : textOf(item);
  return out;
}

/** An attribute's value by local name, or null. */
export function attrOf(node: XmlElement, local: string): string | null {
  return node.attrs.find((a) => a.local === local)?.value ?? null;
}

/** Every element in document order for which `predicate` holds. */
export function findAll(node: XmlElement, predicate: (el: XmlElement) => boolean): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (current: XmlElement): void => {
    if (predicate(current)) found.push(current);
    for (const item of current.children) if (item.kind === 'element') walk(item);
  };
  walk(node);
  return found;
}
