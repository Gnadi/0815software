/**
 * A small, strict XML reader — enough for the e-invoice syntaxes, nothing
 * more, so the service keeps its two runtime dependencies.
 *
 * Namespaces are reduced to local names: UBL, CII and ebInterface each use
 * their element names unambiguously within one document, and the root's
 * namespace (kept on `ns`) is what tells the syntaxes apart. DTDs and
 * processing instructions are skipped, never interpreted — an entity
 * declaration in a supplier's file must not be able to expand into anything
 * (the billion-laughs and XXE classes simply have nothing to run on).
 */

export interface XmlElement {
  name: string;
  /** The element's namespace URI, resolved from its prefix (or the default). */
  ns: string | null;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1);
const prefixOf = (qname: string) => (qname.includes(':') ? qname.slice(0, qname.indexOf(':')) : '');

export class XmlError extends Error {}

/** Parse a whole document. Throws `XmlError` on anything not well-formed. */
export function parseXml(source: string): XmlElement {
  const text = source.replace(/^﻿/, '');
  let i = 0;
  const stack: { el: XmlElement; qname: string; scope: Record<string, string> }[] = [];
  let root: XmlElement | null = null;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      if (text.slice(i).trim() !== '' && stack.length > 0) throw new XmlError('Unclosed element at end of document');
      break;
    }
    if (stack.length > 0) stack[stack.length - 1]!.el.text += decode(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('Unclosed comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('Unclosed CDATA section');
      if (stack.length > 0) stack[stack.length - 1]!.el.text += text.slice(lt + 9, end);
      i = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('Unclosed processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!', lt)) {
      // A DOCTYPE, possibly with an internal subset: skipped whole, never read.
      let depth = 0;
      let j = lt + 2;
      for (; j < text.length; j++) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        else if (text[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end === -1) throw new XmlError('Unclosed end tag');
      const qname = text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.qname !== qname) throw new XmlError(`Mismatched end tag </${qname}>`);
      i = end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= text.length) throw new XmlError('Unclosed start tag');
      let inner = text.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const nameMatch = /^([^\s/>]+)/.exec(inner);
      if (!nameMatch) throw new XmlError('Empty tag name');
      const qname = nameMatch[1]!;
      const attrs: Record<string, string> = {};
      const parentScope = stack.length > 0 ? stack[stack.length - 1]!.scope : {};
      const scope: Record<string, string> = { ...parentScope };
      for (const m of inner.slice(qname.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        const key = m[1]!;
        const value = decode(m[3] ?? m[4] ?? '');
        if (key === 'xmlns') scope[''] = value;
        else if (key.startsWith('xmlns:')) scope[key.slice(6)] = value;
        else attrs[localName(key)] = value;
      }
      const el: XmlElement = { name: localName(qname), ns: scope[prefixOf(qname)] ?? null, attrs, children: [], text: '' };
      if (stack.length > 0) stack[stack.length - 1]!.el.children.push(el);
      else if (root) throw new XmlError('More than one root element');
      else root = el;
      if (!selfClosing) stack.push({ el, qname, scope });
      i = j + 1;
    }
  }
  if (stack.length > 0) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.qname}>`);
  if (!root) throw new XmlError('No root element');
  return root;
}

/** The first descendant reached by following local names, e.g. `path(r, 'A', 'B')`. */
export function path(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let at = el;
  for (const name of names) {
    at = at?.children.find((c) => c.name === name);
    if (!at) return undefined;
  }
  return at;
}

export function all(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** Trimmed text at a path, or null when the element is missing or empty. */
export function textAt(el: XmlElement | undefined, ...names: string[]): string | null {
  const found = path(el, ...names);
  const value = found?.text.trim();
  return value ? value : null;
}
