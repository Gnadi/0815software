import { describe, expect, it } from 'vitest';
import { parseRksv, parseRksvAmount, RksvError, rksvVatLines } from '../shared/rksv.js';

/**
 * The code on an Austrian till receipt (RKSV), read exactly.
 *
 * The codes below are built the way the BMF's reference implementation builds
 * them (a-sit-plus/at-registrierkassen-mustercode,
 * ReceiptRepresentationForSignature.getDataToBeSigned and
 * CashBoxUtils.getQRCodeRepresentationFromJWSCompactRepresentation): the
 * fields joined by "_", the date as yyyy-MM-dd'T'HH:mm:ss, every amount through
 * Java's NumberFormat for Locale.GERMAN with two decimals — so thousands are
 * grouped with a point — and the signature appended in standard base64.
 */

const SIG = 'k2lVUXZ6/9WC/YIM3gl1n3z2YljGcJKuvufYvCUiiYdpCo8LWGdNdPMIhQP4D4bt+oGDdRwwrFjYzPMfxYTK8g==';
const code = (o: Partial<{ suite: string; box: string; no: string; at: string; n: string; r1: string; r2: string; z: string; s: string; turnover: string; sig: string }> = {}) =>
  [
    '',
    o.suite ?? 'R1-AT1',
    o.box ?? 'KASSE-01',
    o.no ?? '83469',
    o.at ?? '2026-10-12T12:31:05',
    o.n ?? '1.234,56',
    o.r1 ?? '12,40',
    o.r2 ?? '0,00',
    o.z ?? '0,00',
    o.s ?? '0,00',
    o.turnover ?? 'lHZnU+ICvLM=',
    '-3667961875706356849',
    'cg8hNU5ihto=',
    o.sig ?? SIG,
  ].join('_');

describe('amounts as Java\'s German number format writes them', () => {
  it('grouped thousands, a decimal comma, negatives', () => {
    expect(parseRksvAmount('0,00')).toBe(0);
    expect(parseRksvAmount('12,40')).toBe(1240);
    expect(parseRksvAmount('1.234,56')).toBe(123456);
    expect(parseRksvAmount('1.000.000,01')).toBe(100000001);
    expect(parseRksvAmount('-3,50')).toBe(-350);
  });

  it('refuses what that format never writes', () => {
    for (const bad of ['12.40', '12,4', '1234.56', '1,234.56', '12,345', '1.23,45', '', ' 1,00']) {
      expect(() => parseRksvAmount(bad), bad).toThrow(RksvError);
    }
  });
});

describe('a receipt', () => {
  it('reads till, number, time and the gross amount per rate', () => {
    const r = parseRksv(code());
    expect(r).toMatchObject({
      suite: 'R1-AT1',
      cashbox_id: 'KASSE-01',
      receipt_id: '83469',
      issued_at: '2026-10-12T12:31:05',
      amounts: { normal: 123456, reduced1: 1240, reduced2: 0, zero: 0, special: 0 },
      total_cents: 124696,
      kind: 'sale',
      signature_failed: false,
      special_rate_ambiguous: false,
    });
    // 20 % and 10 % — the empty rates are left out.
    expect(rksvVatLines(r)).toEqual([
      { rate_bp: 2000, gross_cents: 123456 },
      { rate_bp: 1000, gross_cents: 1240 },
    ]);
  });

  it('13 % and 0 % land in their own fields', () => {
    const r = parseRksv(code({ n: '0,00', r1: '0,00', r2: '89,00', z: '4,20' }));
    expect(rksvVatLines(r)).toEqual([
      { rate_bp: 1300, gross_cents: 8900 },
      { rate_bp: 0, gross_cents: 420 },
    ]);
  });

  it('tolerates the whitespace a scanner adds around it', () => {
    expect(parseRksv(`  ${code()}\n`).receipt_id).toBe('83469');
  });
});

describe('what a receipt says about itself', () => {
  it('a training receipt and a cancellation are not purchases', () => {
    // The turnover counter field then holds base64 "TRA" or "STO".
    expect(parseRksv(code({ turnover: 'VFJB' })).kind).toBe('training');
    expect(parseRksv(code({ turnover: 'U1RP', n: '-12,40', r1: '0,00' })).kind).toBe('cancellation');
  });

  it('a receipt printed while the signature device was down still is one, and says so', () => {
    const r = parseRksv(code({ sig: 'U2ljaGVyaGVpdHNlaW5yaWNodHVuZyBhdXNnZWZhbGxlbg==' }));
    expect(r.kind).toBe('sale');
    expect(r.signature_failed).toBe(true);
    expect(Buffer.from('U2ljaGVyaGVpdHNlaW5yaWNodHVuZyBhdXNnZWZhbGxlbg==', 'base64').toString()).toBe('Sicherheitseinrichtung ausgefallen');
  });
});

describe('the special rate: 19 % until June 2026, then 4,9 % or 19 %', () => {
  it('before July 2026 it is 19 % (Jungholz, Mittelberg)', () => {
    const r = parseRksv(code({ at: '2026-06-30T23:59:59', n: '0,00', r1: '0,00', s: '11,90' }));
    expect(r.special_rate_ambiguous).toBe(false);
    expect(rksvVatLines(r)).toEqual([{ rate_bp: 1900, gross_cents: 1190 }]);
  });

  it('from 1 July 2026 the receipt alone does not say which; the caller is told to ask', () => {
    const r = parseRksv(code({ at: '2026-07-01T08:00:00', n: '0,00', r1: '0,00', s: '5,24' }));
    expect(r.special_rate_ambiguous).toBe(true);
    expect(rksvVatLines(r, 490)).toEqual([{ rate_bp: 490, gross_cents: 524 }]);
    expect(rksvVatLines(r, 1900)).toEqual([{ rate_bp: 1900, gross_cents: 524 }]);
    // An empty special field is no question.
    expect(parseRksv(code({ at: '2026-07-01T08:00:00' })).special_rate_ambiguous).toBe(false);
  });
});

describe('what is not a receipt code', () => {
  it('says why', () => {
    expect(() => parseRksv('https://example.com/menu')).toThrow('not the code of an Austrian cash receipt');
    expect(() => parseRksv(code().split('_').slice(0, 10).join('_'))).toThrow('13 fields; this one has 9');
    expect(() => parseRksv(code({ suite: 'R9-DE1' }))).toThrow('Unknown algorithm suite');
    expect(() => parseRksv(code({ at: '2026-02-30T12:00:00' }))).toThrow('is not the receipt\'s date and time');
    expect(() => parseRksv(code({ n: '12.40' }))).toThrow(RksvError);
    expect(() => parseRksv(code({ box: '' }))).toThrow('names no till');
  });
});
