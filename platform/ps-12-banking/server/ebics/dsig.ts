import { attrOf, canonicalize, el, findAll, render, textOf, type NsMap, type XmlElement } from './xml.js';
import { sha256, signAuth, verifyAuth } from './crypto.js';

/**
 * The `AuthSignature` — XML Digital Signature as EBICS narrows it.
 *
 * A general XML-DSig implementation is a large and dangerous thing: arbitrary
 * transforms, arbitrary reference URIs, arbitrary algorithms, and a long
 * history of signature-wrapping attacks that come from being flexible about
 * *what* was signed. EBICS uses exactly one shape, so this file implements only
 * that shape and refuses everything else:
 *
 * - **One reference**, whose URI is literally `#xpointer(//*[@authenticate='true'])`.
 * - **One transform**: exclusive canonicalisation.
 * - **SHA-256** digest, signed with **RSASSA-PKCS1-v1_5 over SHA-256** using the
 *   X002 key.
 *
 * Because the reference selects nodes by an attribute rather than by id, the
 * signed content is "every element marked `authenticate='true'`, in document
 * order, each canonicalised and concatenated". That selection is the security
 * boundary: `verify` recomputes it from the received document rather than
 * trusting anything the sender said about it, which is what makes a wrapped or
 * relocated element fail instead of passing.
 */

export const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
export const C14N_ALGORITHM = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const DIGEST_ALGORITHM = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const SIGNATURE_ALGORITHM = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

/** The only reference URI EBICS uses — and the only one this file accepts. */
export const AUTHENTICATE_URI = "#xpointer(//*[@authenticate='true'])";

export class SignatureError extends Error {}

/**
 * The bytes the signature covers: every element carrying `authenticate="true"`,
 * in document order, canonicalised and concatenated.
 *
 * Concatenation without a separator is what the xpointer reference means, and
 * it is why the ORDER of the nodes matters as much as their content.
 */
export function authenticatedBytes(root: XmlElement): string {
  const nodes = findAll(root, (node) => attrOf(node, 'authenticate') === 'true');
  if (nodes.length === 0) {
    throw new SignatureError('nothing in this document is marked authenticate="true"');
  }
  return nodes.map((node) => canonicalize(node)).join('');
}

/** The same selection over a document we are BUILDING, before it is parsed. */
export function authenticatedBytesOfBuilt(root: XmlElement, ns: NsMap): string {
  // Rendering the whole document first, then re-reading it, would work — but it
  // would also mean the digest depended on the parser. Rendering each selected
  // node directly keeps the outbound path free of the parser entirely.
  const nodes = findAll(root, (node) => attrOf(node, 'authenticate') === 'true');
  if (nodes.length === 0) {
    throw new SignatureError('nothing in this document is marked authenticate="true"');
  }
  return nodes.map((node) => render(node, ns)).join('');
}

/**
 * Build the `ds:AuthSignature` element for a request under construction.
 *
 * The signature is over the DIGEST of the authenticated bytes — SignedInfo
 * carries that digest, and the RSA signature is over SignedInfo's own canonical
 * form. Two levels, and getting them the wrong way round produces a signature
 * the bank rejects with a message about the reference rather than about the key.
 */
export function buildAuthSignature(params: {
  root: XmlElement;
  ns: NsMap;
  /** The X002 private key, in PEM. */
  authPrivatePem: string;
}): XmlElement {
  const digest = sha256(authenticatedBytesOfBuilt(params.root, params.ns));

  const signedInfo = el('ds:SignedInfo', {}, [
    el('ds:CanonicalizationMethod', { Algorithm: C14N_ALGORITHM }),
    el('ds:SignatureMethod', { Algorithm: SIGNATURE_ALGORITHM }),
    el('ds:Reference', { URI: AUTHENTICATE_URI }, [
      el('ds:Transforms', {}, [el('ds:Transform', { Algorithm: C14N_ALGORITHM })]),
      el('ds:DigestMethod', { Algorithm: DIGEST_ALGORITHM }),
      el('ds:DigestValue', {}, [digest.toString('base64')]),
    ]),
  ]);

  const signature = signAuth(params.authPrivatePem, render(signedInfo, params.ns));

  return el('ds:AuthSignature', {}, [
    signedInfo,
    el('ds:SignatureValue', {}, [signature.toString('base64')]),
  ]);
}

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, when it did — for the log, never for the caller to parse. */
  reason?: string;
}

/**
 * Verify the `AuthSignature` on a response the bank sent.
 *
 * Everything here is recomputed from the received document. The signature says
 * what the bank *claims* it signed; the only safe question is whether that
 * matches what the document *actually contains*, so:
 *
 * 1. the algorithms are checked against the ones EBICS allows — an attacker who
 *    can choose the algorithm can choose a weak one;
 * 2. the reference URI must be the EBICS one, so the signature cannot be made
 *    to cover some other, harmless fragment;
 * 3. the digest is recomputed over the nodes actually marked `authenticate`;
 * 4. only then is the RSA signature checked over SignedInfo.
 *
 * Skipping (2) or (3) is exactly the signature-wrapping mistake: a valid
 * signature over the wrong bytes.
 */
export function verifyAuthSignature(params: {
  root: XmlElement;
  /** The bank's X002 public key, in PEM. */
  bankAuthPublicPem: string;
}): VerifyResult {
  const { root, bankAuthPublicPem } = params;

  const signatureEl = findAll(root, (n) => n.uri === DS_NS && n.local === 'AuthSignature')[0];
  if (signatureEl === undefined) return { ok: false, reason: 'the response carries no AuthSignature' };

  const signedInfo = findAll(signatureEl, (n) => n.uri === DS_NS && n.local === 'SignedInfo')[0];
  if (signedInfo === undefined) return { ok: false, reason: 'the AuthSignature has no SignedInfo' };

  const algorithmOf = (local: string): string | null => {
    const node = findAll(signedInfo, (n) => n.uri === DS_NS && n.local === local)[0];
    return node === undefined ? null : attrOf(node, 'Algorithm');
  };

  if (algorithmOf('CanonicalizationMethod') !== C14N_ALGORITHM) {
    return { ok: false, reason: 'canonicalisation method is not exclusive c14n' };
  }
  if (algorithmOf('SignatureMethod') !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: 'signature method is not rsa-sha256' };
  }
  if (algorithmOf('DigestMethod') !== DIGEST_ALGORITHM) {
    return { ok: false, reason: 'digest method is not sha256' };
  }

  const references = findAll(signedInfo, (n) => n.uri === DS_NS && n.local === 'Reference');
  if (references.length !== 1) {
    return { ok: false, reason: `expected exactly one Reference, found ${references.length}` };
  }
  if (attrOf(references[0]!, 'URI') !== AUTHENTICATE_URI) {
    // A signature over some other fragment is a valid signature over the wrong
    // thing — the whole point of checking this.
    return { ok: false, reason: 'the Reference does not cover the authenticated nodes' };
  }

  const claimed = textOf(findAll(references[0]!, (n) => n.uri === DS_NS && n.local === 'DigestValue')[0] ?? null).trim();
  let actual: string;
  try {
    actual = sha256(authenticatedBytes(root)).toString('base64');
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'could not select the authenticated nodes' };
  }
  if (claimed !== actual) {
    return { ok: false, reason: 'the digest does not match the authenticated nodes of this document' };
  }

  const signatureValue = textOf(
    findAll(signatureEl, (n) => n.uri === DS_NS && n.local === 'SignatureValue')[0] ?? null,
  ).replace(/\s+/g, '');
  if (signatureValue === '') return { ok: false, reason: 'the AuthSignature has no SignatureValue' };

  const signed = verifyAuth(bankAuthPublicPem, canonicalize(signedInfo), Buffer.from(signatureValue, 'base64'));
  return signed ? { ok: true } : { ok: false, reason: 'the signature does not verify against the bank key' };
}
