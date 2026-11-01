import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hardeningFromEnv } from '../server/hardening.js';
import { refreshText } from '../server/search.js';
import type { SearchHit } from '../shared/types.js';
import { binary, testModule, type TestModule } from './helpers/app.js';

/**
 * Full-text search and preview through the API. The property that matters
 * most is the old one: matter isolation. A word in a document in someone
 * else's matter is never a hit — not listed, not counted, not ranked — and
 * its preview and text are a 404 like everything else about it.
 */

const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', name));
const titles = (res: request.Response): string[] => (res.body.hits as SearchHit[]).map((h) => h.title);

let m: TestModule;
let mara: string;
let theo: string;
let iris: string;
let admin: string;
let acmeId: number;
let leaseId: number;

beforeAll(async () => {
  m = await testModule({ hardening: hardeningFromEnv({ RATE_LIMIT_RPM: '0', LOGIN_RATE_LIMIT_RPM: '0' }) });
  [mara, theo, iris, admin] = await Promise.all(['mara', 'theo', 'iris', 'admin'].map((u) => m.login(u)));
  acmeId = (await m.matter(mara, 'MAT-2026-014')).id;
  const lease = await m.upload(mara, acmeId, fixture('mietvertrag-chromium.pdf'), 'Mietvertrag Graz', 'mietvertrag.pdf', 'application/pdf');
  expect(lease.status).toBe(201);
  leaseId = lease.body.document.id;
});

const search = (cookie: string, q: string, extra = '') => request(m.app).get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set('Cookie', cookie);

describe('full-text search', () => {
  it('finds words inside a PDF — umlauts or not, word starts, phrases', async () => {
    expect(titles(await search(mara, 'Kündigungsfrist'))).toEqual(['Mietvertrag Graz']);
    expect(titles(await search(mara, 'kundigungsfrist'))).toEqual(['Mietvertrag Graz']);
    expect(titles(await search(mara, 'Treuhand'))).toEqual(['Mietvertrag Graz']);
    expect(titles(await search(mara, '"drei Monate"'))).toEqual(['Mietvertrag Graz']);
    expect(titles(await search(mara, '"Monate drei"'))).toEqual([]);
    expect(titles(await search(mara, 'Kaution Herrengasse'))).toEqual(['Mietvertrag Graz']);
    expect(titles(await search(mara, 'Kaution Salzburg'))).toEqual([]);
  });

  it('shows the passage, with the words found marked', async () => {
    const [hit] = (await search(mara, 'Treuhandkonto')).body.hits as SearchHit[];
    expect(hit!.snippet).toContain('\u0002Treuhandkonto\u0003');
    expect(hit!.matter_key).toBe('MAT-2026-014');
  });

  it('never finds what the person may not read', async () => {
    // iris has no membership on MAT-2026-014; the admin sees every matter.
    expect(titles(await search(iris, 'Kaution'))).toEqual([]);
    expect(titles(await search(admin, 'Kaution'))).toEqual(['Mietvertrag Graz']);
    // The seeded litigation documents are theo's and iris's, not mara's.
    expect(titles(await search(theo, 'Discovery'))).toContain('Discovery Index');
    expect(titles(await search(mara, 'Discovery'))).toEqual([]);
    // A matter filter on a foreign matter is an empty list, not an error.
    const litigation = await m.matter(theo, 'MAT-2026-021');
    const res = await search(mara, 'Discovery', `&matter=${litigation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.hits).toEqual([]);
  });

  it('a title outranks a passing mention; tags are searchable and filterable', async () => {
    await m.upload(mara, acmeId, Buffer.from('Abrechnung der Nebenkosten für 2025.'), 'Kaution Rückzahlung', 'kaution.txt', 'text/plain');
    expect(titles(await search(mara, 'Kaution'))).toEqual(['Kaution Rückzahlung', 'Mietvertrag Graz']);
    await request(m.app).post(`/api/documents/${leaseId}/tags`).set('Cookie', mara).send({ tag: 'wohnung' }).expect(201);
    expect(titles(await search(mara, 'wohnung', '&tag=wohnung'))).toEqual(['Mietvertrag Graz']);
    expect(titles(await search(mara, 'Kaution', '&tag=wohnung'))).toEqual(['Mietvertrag Graz']);
  });

  it('a new version replaces what is searched; the old text stays readable on its version', async () => {
    const doc = await m.upload(mara, acmeId, Buffer.from('Angebot Gartenpflege Frühjahr'), 'Gartenpflege', 'angebot.txt', 'text/plain');
    const id = doc.body.document.id as number;
    expect(titles(await search(mara, 'Frühjahr'))).toEqual(['Gartenpflege']);
    await request(m.app)
      .post(`/api/documents/${id}/versions?title=Gartenpflege&filename=angebot-v2.txt`)
      .set('Cookie', mara)
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('Angebot Gartenpflege Herbst'))
      .expect(201);
    expect(titles(await search(mara, 'Frühjahr'))).toEqual([]);
    expect(titles(await search(mara, 'Herbst'))).toEqual(['Gartenpflege']);
    const v1 = await request(m.app).get(`/api/documents/${id}/text?version=1`).set('Cookie', mara);
    expect(v1.body).toMatchObject({ version_no: 1, status: 'text', text: 'Angebot Gartenpflege Frühjahr' });
  });

  it('a deleted document is no longer found', async () => {
    const doc = await m.upload(mara, acmeId, Buffer.from('Einmaliges Wort Quastenflosser'), 'Weg damit', 'weg.txt', 'text/plain');
    expect(titles(await search(mara, 'Quastenflosser'))).toEqual(['Weg damit']);
    await request(m.app).delete(`/api/documents/${doc.body.document.id}`).set('Cookie', mara).expect(200);
    expect(titles(await search(mara, 'Quastenflosser'))).toEqual([]);
  });

  it('an installation from before full-text search reads its files on start', async () => {
    m.db.exec('DELETE FROM version_text; DELETE FROM document_search;');
    expect(titles(await search(mara, 'Kaution'))).toEqual([]);
    const result = refreshText(m.db, m.storageDir);
    expect(result.missing).toBe(0);
    expect(result.read).toBeGreaterThan(10);
    expect(titles(await search(mara, 'Kündigungsfrist'))).toEqual(['Mietvertrag Graz']);
  });

  it('re-reading everything is the administrator\'s', async () => {
    expect((await request(m.app).post('/api/admin/reindex').set('Cookie', mara)).status).toBe(403);
    const res = await request(m.app).post('/api/admin/reindex').set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.read).toBeGreaterThan(10);
  });
});

describe('preview', () => {
  it('a PDF is served inline as a PDF — framed by this module only', async () => {
    const res = await binary(request(m.app).get(`/api/documents/${leaseId}/preview`).set('Cookie', mara));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''mietvertrag.pdf");
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect((res.body as Buffer).equals(fixture('mietvertrag-chromium.pdf'))).toBe(true);
    // Everywhere else the hardening default stands.
    const detail = await request(m.app).get(`/api/documents/${leaseId}`).set('Cookie', mara);
    expect(detail.headers['x-frame-options']).toBe('DENY');
    expect(detail.body.versions[0]).toMatchObject({ preview: 'pdf', text_status: 'text', format: 'pdf' });
  });

  it('an image is served sandboxed, with the type its bytes say', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const doc = await m.upload(mara, acmeId, png, 'Logo', 'logo.png', 'text/html');
    const res = await binary(request(m.app).get(`/api/documents/${doc.body.document.id}/preview`).set('Cookie', mara));
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('HTML, SVG and text are never served inline — they are shown as text', async () => {
    const html = await m.upload(mara, acmeId, Buffer.from('<html><body><script>fetch("/api/me")</script><p>Hallo</p></body></html>'), 'Seite', 'seite.png', 'image/png');
    const id = html.body.document.id as number;
    expect((await request(m.app).get(`/api/documents/${id}/preview`).set('Cookie', mara)).status).toBe(415);
    const text = await request(m.app).get(`/api/documents/${id}/text`).set('Cookie', mara);
    expect(text.body).toMatchObject({ status: 'text', format: 'html', preview: 'text', text: 'Hallo', truncated: false });
  });

  it('someone outside the matter gets the same 404 for the preview and the text', async () => {
    expect((await request(m.app).get(`/api/documents/${leaseId}/preview`).set('Cookie', iris)).status).toBe(404);
    expect((await request(m.app).get(`/api/documents/${leaseId}/text`).set('Cookie', iris)).status).toBe(404);
    expect((await request(m.app).get(`/api/documents/${leaseId}/preview?version=9`).set('Cookie', mara)).status).toBe(404);
  });
});
