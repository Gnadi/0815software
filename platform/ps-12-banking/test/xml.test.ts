import { describe, expect, it } from 'vitest';
import {
  at,
  attrOf,
  canonicalize,
  child,
  childrenOf,
  document,
  el,
  escapeAttr,
  escapeText,
  findAll,
  parse,
  render,
  text,
  textOf,
  XmlError,
} from '../server/ebics/xml.js';

/**
 * The canonicalisation layer, tested as the thing every signature depends on.
 *
 * The interesting cases are the ones where "valid XML" and "canonical XML"
 * disagree: self-closing tags, attribute order, which characters are escaped,
 * and — the rule that gives *exclusive* C14N its name — a namespace being
 * declared only where it is visibly used.
 *
 * Several expectations below come from the W3C Canonical XML 1.0 / Exclusive
 * XML Canonicalization test cases; they are reproduced here as literals because
 * this suite must stay offline and dependency-free.
 */

const NS = { '': 'urn:example', e: 'urn:ebics', ds: 'http://www.w3.org/2000/09/xmldsig#' };

describe('escaping', () => {
  it('escapes text as canonical form requires, and nothing more', () => {
    expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    // An apostrophe and a double quote are legal text and stay literal.
    expect(escapeText(`it's "quoted"`)).toBe(`it's "quoted"`);
    // A literal CR would be normalised away by a parser, so it must survive.
    expect(escapeText('a\r\nb')).toBe('a&#xD;\nb');
  });

  it('escapes attribute values differently from text — the difference is the digest', () => {
    // `>` is escaped in TEXT but left literal in an attribute value — one of
    // the places canonical form and "valid XML" quietly disagree.
    expect(escapeAttr('a & b < c > d')).toBe('a &amp; b &lt; c > d');
    expect(escapeAttr('say "hi"')).toBe('say &quot;hi&quot;');
    // Apostrophes stay literal too: escaping them is valid XML and wrong C14N.
    expect(escapeAttr("it's")).toBe("it's");
    // Whitespace inside an attribute must survive parser normalisation.
    expect(escapeAttr('a\tb\nc\rd')).toBe('a&#x9;b&#xA;c&#xD;d');
  });
});

describe('rendering is canonical by construction', () => {
  it('never emits a self-closing tag', () => {
    expect(render(el('e:X'), NS)).toBe('<e:X xmlns:e="urn:ebics"></e:X>');
  });

  it('emits no XML declaration — it is not part of the canonical form', () => {
    const canonical = render(el('e:X'), NS);
    expect(canonical.startsWith('<?xml')).toBe(false);
    // The wire document has one; the digest is taken over the canonical part.
    expect(document(el('e:X'), NS)).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n${canonical}`);
  });

  it('orders attributes by namespace then local name, not by insertion', () => {
    const node = el('e:X', { zebra: '1', alpha: '2', 'ds:beta': '3' });
    expect(render(node, NS)).toBe(
      '<e:X xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:e="urn:ebics"' +
        ' alpha="2" zebra="1" ds:beta="3"></e:X>',
    );
  });

  it('declares the default namespace before prefixed ones', () => {
    expect(render(el('Root', {}, [el('e:Child')]), NS)).toBe(
      '<Root xmlns="urn:example"><e:Child xmlns:e="urn:ebics"></e:Child></Root>',
    );
  });
});

describe('exclusive canonicalisation: visible use only', () => {
  it('declares a namespace on the element that uses it, not on the root', () => {
    // The root does not use `ds`, so — unlike inclusive C14N — it must not
    // declare it. This is the property that lets a signed fragment keep its
    // digest when it is lifted into another document.
    const doc = el('e:Root', {}, [el('e:A'), el('ds:B')]);
    expect(render(doc, NS)).toBe(
      '<e:Root xmlns:e="urn:ebics"><e:A></e:A>' +
        '<ds:B xmlns:ds="http://www.w3.org/2000/09/xmldsig#"></ds:B></e:Root>',
    );
  });

  it('does not redeclare a namespace an ancestor already bound to the same URI', () => {
    const doc = el('e:Root', {}, [el('e:Mid', {}, [el('e:Leaf')])]);
    expect(render(doc, NS)).toBe(
      '<e:Root xmlns:e="urn:ebics"><e:Mid><e:Leaf></e:Leaf></e:Mid></e:Root>',
    );
  });

  it('counts a prefixed ATTRIBUTE as visible use', () => {
    const doc = el('e:Root', {}, [el('e:Child', { 'ds:Id': 'x' })]);
    expect(render(doc, NS)).toBe(
      '<e:Root xmlns:e="urn:ebics">' +
        '<e:Child xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ds:Id="x"></e:Child></e:Root>',
    );
  });

  it('leaves an unprefixed attribute in no namespace, declaring nothing for it', () => {
    // An unprefixed attribute is NOT in the default namespace — a rule that
    // catches people out, and one a wrong digest would hide.
    expect(render(el('Root', { plain: '1' }), NS)).toBe('<Root xmlns="urn:example" plain="1"></Root>');
  });

  it('refuses a prefix the namespace map does not define', () => {
    expect(() => render(el('nope:X'), NS)).toThrow(XmlError);
  });
});

describe('parsing', () => {
  it('resolves prefixes to URIs, so a bank’s naming does not matter', () => {
    const ours = parse('<e:Root xmlns:e="urn:ebics"><e:Leaf>7</e:Leaf></e:Root>');
    const theirs = parse('<ns2:Root xmlns:ns2="urn:ebics"><ns2:Leaf>7</ns2:Leaf></ns2:Root>');
    expect(textOf(child(ours, 'urn:ebics', 'Leaf'))).toBe('7');
    expect(textOf(child(theirs, 'urn:ebics', 'Leaf'))).toBe('7');
    // Identity is the URI; presentation is the prefix, and it is preserved.
    expect(theirs.prefix).toBe('ns2');
    expect(theirs.uri).toBe('urn:ebics');
  });

  it('reads the default namespace, and keeps unprefixed attributes out of it', () => {
    const root = parse('<Root xmlns="urn:example" plain="1"><Leaf/></Root>');
    expect(root.uri).toBe('urn:example');
    expect(child(root, 'urn:example', 'Leaf')).not.toBeNull();
    expect(root.attrs[0]).toMatchObject({ local: 'plain', uri: null, value: '1' });
  });

  it('resolves the predefined entities and character references', () => {
    const root = parse('<X>a &amp; b &lt; c &#65; &#x42;</X>');
    expect(textOf(root)).toBe('a & b < c A B');
    expect(attrOf(parse('<X a="&quot;q&quot; &apos;p&apos;"/>'), 'a')).toBe(`"q" 'p'`);
  });

  it('takes CDATA as plain text and drops comments', () => {
    const root = parse('<X><!-- note --><![CDATA[a < b & c]]></X>');
    expect(textOf(root)).toBe('a < b & c');
  });

  it('refuses what it does not implement rather than guessing', () => {
    expect(() => parse('<!DOCTYPE X><X/>')).toThrow(/DTDs/);
    expect(() => parse('<?php echo ?><X/>')).toThrow(/processing instructions/);
    expect(() => parse('<X>&custom;</X>')).toThrow(/unsupported entity/);
  });

  it('refuses malformed documents', () => {
    expect(() => parse('<X><Y></X>')).toThrow(XmlError);
    expect(() => parse('<X>')).toThrow(/unclosed element/);
    expect(() => parse('<X/><Y/>')).toThrow(/only have one root/);
    expect(() => parse('   ')).toThrow(/no root element/);
  });
});

describe('canonicalize(parse(x)) — the bytes a bank signature is checked against', () => {
  it('normalises layout without renaming anything', () => {
    const wire = `<?xml version="1.0"?>\n<ns2:Root xmlns:ns2="urn:ebics"  b="2"   a="1">\n` +
      `  <ns2:Empty/><!-- dropped --></ns2:Root>`;
    expect(canonicalize(parse(wire))).toBe(
      '<ns2:Root xmlns:ns2="urn:ebics" a="1" b="2">\n  <ns2:Empty></ns2:Empty></ns2:Root>',
    );
  });

  it('is idempotent: canonicalising a canonical document changes nothing', () => {
    const once = canonicalize(parse('<A xmlns="urn:x"><B c="1"/>text</A>'));
    expect(canonicalize(parse(once))).toBe(once);
  });

  it('round-trips a document we wrote ourselves, byte for byte', () => {
    const ours = render(
      el('e:Root', { 'ds:Id': 'sig' }, [el('e:Leaf', {}, ['a & b']), el('ds:Other')]),
      NS,
    );
    expect(canonicalize(parse(ours))).toBe(ours);
  });

  /**
   * These expectations were cross-checked against an independent
   * canonicaliser (Python's `xml.etree.ElementTree.canonicalize`) and agreed
   * byte for byte. They are the cases where a hand-rolled implementation is
   * most likely to be quietly wrong.
   */
  it('handles a document with no namespaces at all', () => {
    expect(canonicalize(parse('<X b="2" a="1"><Y/></X>'))).toBe('<X a="1" b="2"><Y></Y></X>');
  });

  it('emits xmlns="" to undeclare a default namespace a child leaves', () => {
    // Without the undeclaration, <Kid> would read as being in urn:d — a
    // different document with the same digest, which is the whole danger.
    expect(canonicalize(parse('<Root xmlns="urn:d"><Kid xmlns=""><G/></Kid></Root>'))).toBe(
      '<Root xmlns="urn:d"><Kid xmlns=""><G></G></Kid></Root>',
    );
  });

  it('preserves whitespace in text, which is signed like any other character', () => {
    expect(canonicalize(parse('<X>  spaced  </X>'))).toBe('<X>  spaced  </X>');
    expect(canonicalize(parse('<X>line1\nline2</X>'))).toBe('<X>line1\nline2</X>');
  });

  it('gives two spellings of the same document the same canonical form', () => {
    // Same infoset, different serialisation: attribute order, empty-element
    // syntax and a comment. A digest must not be able to tell them apart.
    const a = canonicalize(parse('<X xmlns="urn:x" p="1" q="2"><Y></Y></X>'));
    const b = canonicalize(parse('<X xmlns="urn:x" q="2" p="1"><!--c--><Y/></X>'));
    expect(a).toBe(b);
  });
});

describe('reading values out of a response', () => {
  const response = parse(
    `<h:ebicsResponse xmlns:h="urn:ebics" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
       <h:header authenticate="true">
         <h:static><h:TransactionID>ABC123</h:TransactionID></h:static>
         <h:mutable><h:ReturnCode>000000</h:ReturnCode><h:ReportText>[EBICS_OK]</h:ReportText></h:mutable>
       </h:header>
       <h:body><h:ReturnCode>000000</h:ReturnCode></h:body>
     </h:ebicsResponse>`,
  );

  it('walks a path of local names inside one namespace', () => {
    expect(textOf(at(response, 'urn:ebics', 'header', 'static', 'TransactionID'))).toBe('ABC123');
    expect(textOf(at(response, 'urn:ebics', 'header', 'mutable', 'ReportText'))).toBe('[EBICS_OK]');
  });

  it('returns null for a path that is not there, instead of throwing', () => {
    expect(at(response, 'urn:ebics', 'header', 'nope')).toBeNull();
    expect(textOf(at(response, 'urn:ebics', 'nope'))).toBe('');
  });

  it('distinguishes the two ReturnCodes by where they are', () => {
    // A technical code in the header and a business code in the body: reading
    // the wrong one is how an implementation reports success on a rejection.
    expect(textOf(at(response, 'urn:ebics', 'header', 'mutable', 'ReturnCode'))).toBe('000000');
    expect(textOf(at(response, 'urn:ebics', 'body', 'ReturnCode'))).toBe('000000');
    expect(childrenOf(response, 'urn:ebics', 'body')).toHaveLength(1);
  });

  it('finds the authenticated nodes the signature covers', () => {
    const authenticated = findAll(response, (node) => attrOf(node, 'authenticate') === 'true');
    expect(authenticated).toHaveLength(1);
    expect(authenticated[0]!.local).toBe('header');
  });
});

describe('the builder', () => {
  it('drops null and undefined children so optional parts read cleanly', () => {
    const node = el('e:X', {}, [el('e:A'), null, undefined, 'tail']);
    expect(render(node, NS)).toBe('<e:X xmlns:e="urn:ebics"><e:A></e:A>tail</e:X>');
  });

  it('takes a bare string as a text node', () => {
    expect(render(el('e:X', {}, [text('v')]), NS)).toBe(render(el('e:X', {}, ['v']), NS));
  });
});
