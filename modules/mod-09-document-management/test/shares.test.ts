import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { tokenHash } from '../server/shares.js';
import { binary, testModule, type TestModule } from './helpers/app.js';

/**
 * Share links: one document, for someone without an account, for a while.
 * Who may make them is the administrator's setting; the link is the only
 * credential, so every way it can stop working looks the same from outside.
 */

let m: TestModule;
let mara: string; // owner of MAT-2026-014
let theo: string; // editor there
let admin: string;
let docId: number;

beforeEach(async () => {
  m = await testModule();
  [mara, theo, admin] = await Promise.all(['mara', 'theo', 'admin'].map((u) => m.login(u)));
  const acme = await m.matter(mara, 'MAT-2026-014');
  const doc = await m.upload(mara, acme.id, Buffer.from('Vertraulicher Bericht für den Steuerberater'), 'Bericht', 'bericht.txt', 'text/plain');
  docId = doc.body.document.id;
});

const share = (cookie: string, body: Record<string, unknown> = {}, id = docId) => request(m.app).post(`/api/documents/${id}/shares`).set('Cookie', cookie).send(body);
const open = (token: string) => request(m.app).get(`/api/shared/${token}`);
const download = (token: string, grant?: string) => binary(request(m.app).get(`/api/shared/${token}/download${grant ? `?grant=${encodeURIComponent(grant)}` : ''}`));
const settings = (body: Record<string, unknown>) => request(m.app).put('/api/settings').set('Cookie', admin).send(body);

describe('making a link', () => {
  it('an editor makes one; the token is in the answer and nowhere in the database', async () => {
    const res = await share(theo, { note: 'Steuerberater' });
    expect(res.status).toBe(201);
    const { token, link, path } = res.body as { token: string; link: { expires_at: string; status: string }; path: string };
    expect(path).toBe(`/s/${token}`);
    expect(link.status).toBe('active');
    // 14 days by default, from the injected clock.
    expect(link.expires_at).toBe('2026-11-15T10:00:00Z');
    const dump = JSON.stringify(m.db.prepare('SELECT * FROM share_links').all());
    expect(dump).not.toContain(token);
    expect(dump).toContain(tokenHash(token));
    // The document's history says who made it.
    const detail = await request(m.app).get(`/api/documents/${docId}`).set('Cookie', mara);
    expect(detail.body.events[0]).toMatchObject({ kind: 'share_created', actor_name: 'Theo Brandt' });
    expect(detail.body.shares).toHaveLength(1);
    expect(detail.body.can_share).toBe(true);
  });

  it('a viewer may not, and does not see the links', async () => {
    const helios = await m.matter(mara, 'MAT-2026-033'); // mara is a viewer there
    const docs = await request(m.app).get(`/api/documents?matter=${helios.id}`).set('Cookie', mara);
    const id = docs.body.documents[0].id as number;
    expect((await share(mara, {}, id)).status).toBe(403);
    const detail = await request(m.app).get(`/api/documents/${id}`).set('Cookie', mara);
    expect(detail.body.shares).toBeNull();
    expect(detail.body.can_share).toBe(false);
  });

  it('who may is the administrator\'s choice — editors and owners, owners only, or nobody', async () => {
    expect((await request(m.app).put('/api/settings').set('Cookie', mara).send({ share_links: 'owner' })).status).toBe(403);
    expect((await settings({ share_links: 'owner' })).body.share_links).toBe('owner');
    expect((await share(theo)).status).toBe(403);
    expect((await share(mara)).status).toBe(201);
    expect((await settings({ share_links: 'off' })).status).toBe(200);
    expect((await share(mara)).status).toBe(403);
    expect((await settings({ share_links: 'everyone' })).status).toBe(422);
  });

  it('within the limits set: lifetime, password, downloads', async () => {
    await settings({ share_max_days: 7, share_default_days: 7, share_require_password: true });
    expect((await share(theo, { days: 30, password: 'geheim-123' })).body.details).toEqual([{ field: 'days', message: 'a link may live from 1 to 7 days' }]);
    expect((await share(theo, { days: 3 })).body.details).toEqual([{ field: 'password', message: 'a password is required for share links' }]);
    expect((await share(theo, { password: 'kurz' })).body.details).toEqual([{ field: 'password', message: 'at least 8 characters' }]);
    expect((await share(theo, { version_no: 7, password: 'geheim-123' })).body.details).toEqual([{ field: 'version_no', message: 'no such version' }]);
    expect((await settings({ share_default_days: 10 })).status).toBe(422);
  });
});

describe('using a link', () => {
  it('shows the document and nothing about the matter or the people', async () => {
    const { token } = (await share(theo)).body;
    const res = await open(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: 'Bericht',
      filename: 'bericht.txt',
      size_bytes: Buffer.byteLength('Vertraulicher Bericht für den Steuerberater'),
      version_no: 1,
      preview: 'text',
      expires_at: '2026-11-15T10:00:00Z',
      password_required: false,
      downloads_left: null,
    });
    const file = await download(token);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).toString()).toBe('Vertraulicher Bericht für den Steuerberater');
    expect((await request(m.app).get(`/api/shared/${token}/text`)).body.text).toBe('Vertraulicher Bericht für den Steuerberater');
  });

  it('a link to the current version follows new uploads; a pinned one does not', async () => {
    const current = (await share(theo)).body.token as string;
    const pinned = (await share(theo, { version_no: 1 })).body.token as string;
    await request(m.app)
      .post(`/api/documents/${docId}/versions?title=Bericht&filename=bericht-v2.txt`)
      .set('Cookie', theo)
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('Zweite Fassung'))
      .expect(201);
    expect(((await download(current)).body as Buffer).toString()).toBe('Zweite Fassung');
    expect(((await download(pinned)).body as Buffer).toString()).toBe('Vertraulicher Bericht für den Steuerberater');
  });

  it('downloads are counted from the log, and a link with a limit is used up', async () => {
    const { token } = (await share(theo, { max_downloads: 2 })).body;
    await download(token).expect(200);
    expect((await open(token)).body.downloads_left).toBe(1);
    await download(token).expect(200);
    expect((await open(token)).status).toBe(404);
    expect((await download(token)).status).toBe(404);
    const detail = await request(m.app).get(`/api/documents/${docId}`).set('Cookie', theo);
    expect(detail.body.shares[0]).toMatchObject({ status: 'used_up', downloads: 2 });
  });

  it('a password: no grant, no file; a wrong one is logged; ten in a row lock the link', async () => {
    const { token } = (await share(theo, { password: 'geheim-123' })).body;
    expect((await open(token)).body.password_required).toBe(true);
    expect((await download(token)).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await request(m.app).post(`/api/shared/${token}/unlock`).send({ password: `falsch-${i}` })).status).toBe(401);
    // Even the right password waits out the window.
    expect((await request(m.app).post(`/api/shared/${token}/unlock`).send({ password: 'geheim-123' })).status).toBe(429);
    m.clock.now += 16 * 60_000;
    const unlocked = await request(m.app).post(`/api/shared/${token}/unlock`).send({ password: 'geheim-123' });
    expect(unlocked.status).toBe(200);
    expect((await download(token, unlocked.body.grant)).status).toBe(200);
    // A grant is for one link only, and only for half an hour.
    const other = (await share(theo, { password: 'anderes-pw' })).body.token as string;
    expect((await download(other, unlocked.body.grant)).status).toBe(401);
    m.clock.now += 31 * 60_000;
    expect((await download(token, unlocked.body.grant)).status).toBe(401);
  });

  it('every way a link stops working is the same 404', async () => {
    const expired = (await share(theo, { days: 1 })).body.token as string;
    const revoked = (await share(theo)).body;
    const unknown = 'x'.repeat(43);
    await request(m.app).delete(`/api/shares/${revoked.link.id}`).set('Cookie', theo).expect(200);
    m.clock.now += 2 * 86_400_000;
    for (const token of [expired, revoked.token, unknown]) {
      const res = await open(token);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Link not found', details: [] });
    }
    // The document deleted, the links switched off: likewise.
    const live = (await share(theo)).body.token as string;
    await settings({ share_links: 'off' });
    expect((await open(live)).status).toBe(404);
    await settings({ share_links: 'editor' });
    expect((await open(live)).status).toBe(200);
    await request(m.app).delete(`/api/documents/${docId}`).set('Cookie', mara).expect(200);
    expect((await open(live)).status).toBe(404);
  });
});

describe('revoking', () => {
  it('the maker and the matter\'s owners may; others may not; outsiders learn nothing', async () => {
    const byTheo = (await share(theo)).body.link.id as number;
    const byMara = (await share(mara)).body.link.id as number;
    expect((await request(m.app).delete(`/api/shares/${byMara}`).set('Cookie', theo)).status).toBe(403);
    const iris = await m.login('iris');
    // Same answer as for a link that never existed.
    const outsider = await request(m.app).delete(`/api/shares/${byTheo}`).set('Cookie', iris);
    const nothing = await request(m.app).delete('/api/shares/99999').set('Cookie', iris);
    expect([outsider.status, outsider.body]).toEqual([nothing.status, nothing.body]);
    expect(outsider.status).toBe(404);
    const revoked = await request(m.app).delete(`/api/shares/${byTheo}`).set('Cookie', mara);
    expect(revoked.body.link).toMatchObject({ status: 'revoked', revoked_by_name: 'Mara Voss', can_revoke: false });
    expect((await request(m.app).delete(`/api/shares/${byTheo}`).set('Cookie', mara)).status).toBe(409);
  });
});
