import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import {
  code128Modules,
  code128Values,
  ean13Modules,
  ean8Modules,
  gtinCheckDigit,
  isValidGtin,
  productBarcode,
  upcaModules,
} from '../shared/barcode.js';

/**
 * Every vector below was produced by python-barcode 0.15 (an independent
 * implementation): `EAN13(c).build()`, `Code128(t)._build()` and `.build()`.
 * The labels must scan, so our own reading of the standard is not evidence.
 */

describe('GTIN check digits (GS1 mod-10)', () => {
  it('computes the published check digits', () => {
    expect(gtinCheckDigit('400638133393')).toBe(1);
    expect(gtinCheckDigit('978030640615')).toBe(7);
    expect(gtinCheckDigit('9638507')).toBe(4);
    expect(gtinCheckDigit('03600029145')).toBe(2);
  });

  it('accepts GTIN-8/12/13/14 with the right digit and refuses the rest', () => {
    for (const ok of ['4006381333931', '9780306406157', '96385074', '036000291452', '00012345600012']) expect(isValidGtin(ok)).toBe(true);
    for (const bad of ['4006381333932', '400638133393', 'ABC', '1234567', '96385075', '']) expect(isValidGtin(bad)).toBe(false);
  });
});

describe('EAN / UPC bars', () => {
  it('EAN-13', () => {
    expect(ean13Modules('4006381333931')).toBe(
      '10100011010100111010111101111010001001011001101010100001010000101000010111010010000101100110101',
    );
    expect(ean13Modules('9780306406157')).toBe(
      '10101110110001001010011101111010100111010111101010101110011100101010000110011010011101000100101',
    );
    expect(() => ean13Modules('4006381333932')).toThrow();
  });

  it('EAN-8 and UPC-A', () => {
    expect(ean8Modules('96385074')).toBe('1010001011010111101111010110111010101001110111001010001001011100101');
    expect(upcaModules('036000291452')).toBe(
      '10100011010111101010111100011010001101000110101010110110011101001100110101110010011101101100101',
    );
  });
});

describe('Code 128', () => {
  const vectors: [string, number[], string][] = [
    ['HW-1001', [104, 40, 55, 13, 99, 10, 1], '11010010000110001010001110100011010011011100101110111101100100010011001101100111010011001100011101011'],
    ['PK-6002', [104, 48, 43, 13, 99, 60, 2], '11010010000111011101101011000111010011011100101110111101110111101011001100110111011000101100011101011'],
    ['AB-12', [104, 33, 34, 13, 17, 18], '110100100001010001100010001011000100110111001001110011011001110010101000111101100011101011'],
    ['SKU-123456-X', [104, 51, 43, 53, 13, 99, 12, 34, 56, 100, 13, 56], '110100100001101110100010110001110110111011101001101110010111011110101100111001000101100011100010110101111011101001101110011100010110111010001101100011101011'],
    ['12345678', [105, 12, 34, 56, 78], '1101001110010110011100100010110001110001011011000010100100011101101100011101011'],
    ['12345', [105, 12, 34, 100, 21], '1101001110010110011100100010110001011110111011011100100111010110001100011101011'],
    ['a b~', [104, 65, 0, 66, 94], '1101001000010010110000110110011001001000011010001011110110011101001100011101011'],
  ];
  it.each(vectors)('%s', (text, values, modules) => {
    // python-barcode's _build() omits the check symbol; ours carries it last.
    expect(code128Values(text).slice(0, -1)).toEqual(values);
    expect(code128Modules(text)).toBe(modules);
  });

  it('refuses what it cannot encode', () => {
    expect(() => code128Modules('')).toThrow();
    expect(() => code128Modules('Größe')).toThrow();
  });
});

describe('choosing the label barcode', () => {
  it('uses the GTIN when there is a valid one, the SKU otherwise', () => {
    expect(productBarcode({ sku: 'HW-1001', barcode: '4006381333931' }).symbology).toBe('EAN-13');
    expect(productBarcode({ sku: 'HW-1001', barcode: '96385074' }).symbology).toBe('EAN-8');
    expect(productBarcode({ sku: 'HW-1001', barcode: '036000291452' }).symbology).toBe('UPC-A');
    expect(productBarcode({ sku: 'HW-1001', barcode: null })).toMatchObject({ symbology: 'Code 128', text: 'HW-1001' });
    // GTIN-14 is for cartons (ITF-14), not a retail label: fall back to the SKU.
    expect(productBarcode({ sku: 'HW-1001', barcode: '00012345600012' }).symbology).toBe('Code 128');
  });
});

describe('products carry a GTIN, and a scan finds them', () => {
  const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
  const edit = `${COOKIE_NAME}=${createToken(auth, 'e@example', Date.now(), 'edit')}`;
  const view = `${COOKIE_NAME}=${createToken(auth, 'v@example', Date.now(), 'view')}`;
  let app: Express;
  beforeEach(() => {
    const db = openDb(':memory:');
    seed(db);
    app = createApp({ db, auth });
  });

  it('accepts a GTIN with a valid check digit (spaces as printed are dropped) and refuses a typo', async () => {
    const created = await request(app)
      .post('/api/products')
      .set('Cookie', edit)
      .send({ sku: 'NEW-1', name: 'Neu', barcode: '4 006381 333931' })
      .expect(201);
    expect(created.body.barcode).toBe('4006381333931');
    const typo = await request(app).post('/api/products').set('Cookie', edit).send({ sku: 'NEW-2', name: 'x', barcode: '4006381333932' }).expect(422);
    expect(typo.body.details).toEqual([expect.objectContaining({ field: 'barcode' })]);
    // One barcode, one product — named as such.
    const twice = await request(app).post('/api/products').set('Cookie', edit).send({ sku: 'NEW-3', name: 'x', barcode: '4006381333931' }).expect(422);
    expect(twice.body.details[0]).toEqual({ field: 'barcode', message: 'Barcode 4006381333931 already belongs to NEW-1' });
    // Keeping one's own barcode on an update is not a clash; clearing it is allowed.
    await request(app).put(`/api/products/${created.body.id}`).set('Cookie', edit).send({ sku: 'NEW-1', name: 'Neu 2', barcode: '4006381333931' }).expect(200);
    const cleared = await request(app).put(`/api/products/${created.body.id}`).set('Cookie', edit).send({ sku: 'NEW-1', name: 'Neu 2', barcode: '' }).expect(200);
    expect(cleared.body.barcode).toBeNull();
  });

  it('a scan resolves a GTIN or a SKU, case as typed, and says plainly when nothing matches', async () => {
    expect((await request(app).get('/api/products/lookup?code=4260123450007').set('Cookie', view).expect(200)).body.product.sku).toBe('HW-1001');
    expect((await request(app).get('/api/products/lookup?code=pk-6002').set('Cookie', view).expect(200)).body.product.sku).toBe('PK-6002');
    const none = await request(app).get('/api/products/lookup?code=0000000000000').set('Cookie', view).expect(404);
    expect(none.body.error).toMatch(/No product with barcode or SKU/);
    await request(app).get('/api/products/lookup').set('Cookie', view).expect(422);
    // The overview carries the barcode for the label and the edit form.
    const stock = (await request(app).get('/api/stock').set('Cookie', view).expect(200)).body.rows as { sku: string; barcode: string | null }[];
    expect(stock.find((r) => r.sku === 'HW-1001')?.barcode).toBe('4260123450007');
  });
});
