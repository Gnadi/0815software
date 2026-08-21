/**
 * The DER encoding primitives EBICS needs.
 *
 * Extracted from `parse.ts`, where they existed to rebuild a public key from a
 * modulus and exponent, because EBICS 3.0 needs rather more of them: the
 * subscriber's keys travel as **X.509 certificates**, and `node:crypto` can
 * parse a certificate but cannot issue one.
 *
 * This is deliberately the smallest set that builds a valid certificate. DER
 * is unforgiving and silently so — a length byte wrong by one produces
 * something that parses as a different structure rather than failing — so
 * everything here is checked against `node:crypto`'s own parser in the tests:
 * whatever this module builds, `new X509Certificate(...)` must read back with
 * the same subject, validity and public key.
 */

export function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag + length + body, the shape of every DER value. */
export function derTagged(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

export function derSequence(parts: Buffer[]): Buffer {
  return derTagged(0x30, Buffer.concat(parts));
}

/** A SET, which DER writes sorted — with one member that is moot. */
export function derSet(parts: Buffer[]): Buffer {
  return derTagged(0x31, Buffer.concat(parts));
}

/**
 * A DER INTEGER, which has two rules and needs both.
 *
 * 1. **Signed.** A leading byte >= 0x80 needs a 0x00 in front, or the value
 *    reads as negative — this is why an RSA modulus is almost always padded.
 * 2. **Minimal.** Redundant leading zero bytes are FORBIDDEN. OpenSSL rejects
 *    a non-minimal integer with "illegal padding" rather than tolerating it.
 *
 * The second rule was missing, and it failed roughly one run in three: the
 * certificate serial is 16 random bytes, and about 1 in 256 of those starts
 * with 0x00. The result was a certificate that could not be re-parsed —
 * intermittently, which is the worst way for an encoder to be wrong.
 */
export function derInteger(value: Buffer): Buffer {
  let start = 0;
  // Strip leading zeros, keeping one if the next byte would look negative.
  while (start + 1 < value.length && value[start] === 0x00 && value[start + 1]! < 0x80) start += 1;
  const trimmed = value.subarray(start);
  const body =
    trimmed.length === 0
      ? Buffer.from([0])
      : trimmed[0]! >= 0x80
        ? Buffer.concat([Buffer.from([0]), trimmed])
        : Buffer.from(trimmed);
  return derTagged(0x02, body);
}

export function derBitString(content: Buffer, unusedBits = 0): Buffer {
  return derTagged(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
}

export function derOctetString(content: Buffer): Buffer {
  return derTagged(0x04, content);
}

export function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

export function derBoolean(value: boolean): Buffer {
  // DER, unlike BER, requires TRUE to be exactly 0xFF.
  return Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
}

export function derUtf8String(value: string): Buffer {
  return derTagged(0x0c, Buffer.from(value, 'utf8'));
}

export function derPrintableString(value: string): Buffer {
  return derTagged(0x13, Buffer.from(value, 'ascii'));
}

/**
 * An object identifier, from its dotted form.
 *
 * The first two arcs share a byte (40*a + b); every arc after that is base-128
 * with the high bit set on all but the last byte.
 */
export function derOid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((n) => Number.parseInt(n, 10));
  if (arcs.length < 2 || arcs.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`not an object identifier: ${dotted}`);
  }
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    let rest = Math.floor(arc / 128);
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...chunk);
  }
  return derTagged(0x06, Buffer.from(bytes));
}

/**
 * A time, as X.509 spells it.
 *
 * UTCTime below 2050 and GeneralizedTime from 2050 — RFC 5280 requires exactly
 * that split, and a certificate that uses the wrong one is rejected by strict
 * parsers with a message about the date rather than about the encoding.
 */
export function derTime(date: Date): Buffer {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest =
    `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return year < 2050
    ? derTagged(0x17, Buffer.from(`${p(year % 100)}${rest}`, 'ascii'))
    : derTagged(0x18, Buffer.from(`${p(year, 4)}${rest}`, 'ascii'));
}

/** `[n] EXPLICIT` — a constructed context-specific wrapper. */
export function derExplicit(tag: number, body: Buffer): Buffer {
  return derTagged(0xa0 | tag, body);
}

/** Wrap DER in a PEM envelope of the given label. */
export function pem(label: string, der: Buffer): string {
  const body = (der.toString('base64').match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
