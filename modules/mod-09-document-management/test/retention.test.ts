import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { dueFrom, RETENTION_PRESETS, retentionEnd, todayFor } from '../server/retention.js';
import type { PlatformHooks } from '../server/platform.js';
import type { DueDocument } from '../shared/types.js';
import { testModule } from './helpers/app.js';

/**
 * Retention periods are the law's arithmetic, so the tests start from the
 * law's text (retrieved 1 November 2026):
 *
 *   BAO § 132 Abs. 1 (AT): "… sind sieben Jahre aufzubewahren … Diese Fristen
 *     laufen … für die Belege, Geschäftspapiere und sonstigen Unterlagen vom
 *     Schluß des Kalenderjahres, auf das sie sich beziehen"
 *   UGB § 212 (AT): "… sieben Jahre lang geordnet aufzubewahren" (Abs. 1);
 *     "Die Frist läuft vom Schluß des Kalenderjahrs an …" (Abs. 2)
 *   HGB § 257 Abs. 4 (DE): "Die in Absatz 1 Nummer 1 aufgeführten Unterlagen
 *     sind zehn Jahre, die in Absatz 1 Nummer 4 aufgeführten Unterlagen acht
 *     Jahre und die sonstigen in Absatz 1 aufgeführten Unterlagen sechs Jahre
 *     aufzubewahren." Abs. 5: "Die Aufbewahrungsfrist beginnt mit dem Schluß
 *     des Kalenderjahrs, in dem … der Buchungsbeleg entstanden ist."
 *   AO § 147 Abs. 3–4 (DE): the same 10 / 8 / 6 years, from "dem Schluss des
 *     Kalenderjahrs"; and the period "läuft jedoch nicht ab, soweit und
 *     solange die Unterlagen für Steuern von Bedeutung sind" — a legal hold.
 *
 * Disposal is by hand, by an administrator, never on a timer — and it
 * destroys what it says and records that it did.
 */

describe('the arithmetic of the law', () => {
  it('BAO § 132 / UGB § 212: a voucher of 5 March 2026 is kept to 31 December 2033', () => {
    expect(retentionEnd('2026-03-05', 7)).toBe('2033-12-31');
    expect(dueFrom('2026-03-05', 7)).toBe('2034-01-01');
    // The day in the year does not matter — the period starts at its end.
    expect(retentionEnd('2026-01-01', 7)).toBe(retentionEnd('2026-12-31', 7));
  });

  it('HGB § 257 / AO § 147: books 10 years, vouchers 8, letters 6 — from the end of the year', () => {
    expect(retentionEnd('2025-06-30', 10)).toBe('2035-12-31');
    expect(retentionEnd('2025-06-30', 8)).toBe('2033-12-31');
    expect(retentionEnd('2025-06-30', 6)).toBe('2031-12-31');
  });

  it('the presets say what the texts above say', () => {
    expect(RETENTION_PRESETS.map((p) => [p.years, p.basis.split(';')[0]])).toEqual([
      [7, 'BAO § 132 Abs. 1'],
      [10, 'HGB § 257 Abs. 1 Nr. 1, Abs. 4–5'],
      [8, 'HGB § 257 Abs. 1 Nr. 4, Abs. 4–5'],
      [6, 'HGB § 257 Abs. 1 Nr. 2–3, Abs. 4–5'],
    ]);
  });

  it('a day counts once it has begun everywhere — never a few hours early', () => {
    // 1 January 2034, 00:30 in Vienna, is still 31 December in UTC−12.
    expect(todayFor(Date.parse('2034-01-01T00:30:00+01:00'))).toBe('2033-12-31');
    expect(todayFor(Date.parse('2034-01-01T12:00:00Z'))).toBe('2034-01-01');
  });
});

/** A platform that records what disposal asked it to remove. */
function recordingPlatform(): PlatformHooks & { removed: { docId: number; versions?: number[] }[] } {
  const removed: { docId: number; versions?: number[] }[] = [];
  return {
    removed,
    async documentUploaded() {},
    async audit() {},
    async documentRemoved(docId, versions) {
      removed.push({ docId, versions });
      return { search: 'removed', files: 'failed' };
    },
  };
}

describe('retention through the API', () => {
  it('classes are the administrator\'s; a class in use cannot be deleted', async () => {
    const m = await testModule();
    const [admin, mara] = await Promise.all([m.login('admin'), m.login('mara')]);
    const list = await request(m.app).get('/api/retention-classes').set('Cookie', mara);
    expect(list.body.classes.map((c: { name: string }) => c.name)).toContain('AT — books, records and vouchers');
    expect(list.body.presets).toHaveLength(4);
    expect((await request(m.app).post('/api/retention-classes').set('Cookie', mara).send({ name: 'X', years: 3 })).status).toBe(403);
    const created = await request(m.app).post('/api/retention-classes').set('Cookie', admin).send({ name: 'Verträge (10 Jahre nach Ende)', years: 10, basis: 'ABGB § 1489 (Verjährung)' });
    expect(created.status).toBe(201);
    expect((await request(m.app).post('/api/retention-classes').set('Cookie', admin).send({ name: 'Verträge (10 Jahre nach Ende)', years: 10 })).status).toBe(422);
    expect((await request(m.app).post('/api/retention-classes').set('Cookie', admin).send({ name: 'Y', years: 0 })).status).toBe(422);
    const at = (list.body.classes as { id: number; name: string }[]).find((c) => c.name.startsWith('AT'))!;
    expect((await request(m.app).delete(`/api/retention-classes/${at.id}`).set('Cookie', admin)).status).toBe(409);
    expect((await request(m.app).delete(`/api/retention-classes/${created.body.class.id}`).set('Cookie', admin)).status).toBe(200);
  });

  it('a matter\'s class goes to its new documents; an owner sets class and date, a viewer may not', async () => {
    const m = await testModule();
    const [admin, theo, iris] = await Promise.all([m.login('admin'), m.login('theo'), m.login('iris')]);
    const litigation = await m.matter(theo, 'MAT-2026-021'); // theo owns it, iris views it; seeded with the AT class
    expect(litigation.retention_class_id).not.toBeNull();
    const doc = await m.upload(theo, litigation.id, Buffer.from('Beleg'), 'Beleg', 'beleg.txt', 'text/plain');
    const id = doc.body.document.id as number;
    // Without a date of its own a document counts from the day it was uploaded
    // — today, whenever this runs; seven years for the AT class from there.
    const uploaded = doc.body.retention.document_date as string;
    expect(uploaded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const year = Number(uploaded.slice(0, 4));
    expect(doc.body.retention).toMatchObject({ class_name: 'AT — books, records and vouchers', document_date_set: false, retention_end: `${year + 7}-12-31`, due_from: `${year + 8}-01-01`, due: false });
    expect((await request(m.app).put(`/api/documents/${id}/retention`).set('Cookie', iris).send({ document_date: '2020-01-01' })).status).toBe(403);
    const classes = (await request(m.app).get('/api/retention-classes').set('Cookie', admin)).body.classes as { id: number; name: string }[];
    const letters = classes.find((c) => c.name.startsWith('DE — business letters'))!;
    const set = await request(m.app).put(`/api/documents/${id}/retention`).set('Cookie', theo).send({ retention_class_id: letters.id, document_date: '2019-02-28' });
    expect(set.body.retention).toMatchObject({ years: 6, document_date: '2019-02-28', retention_end: '2025-12-31', due: true });
    expect((await request(m.app).put(`/api/documents/${id}/retention`).set('Cookie', theo).send({ document_date: '2019-02-30' })).status).toBe(422);
    const detail = await request(m.app).get(`/api/documents/${id}`).set('Cookie', theo);
    expect(detail.body.events[0]).toMatchObject({ kind: 'retention_set', detail: 'DE — business letters (6 years), dated 2019-02-28', actor_name: 'Theo Brandt' });
    // A matter's default is its owner's to change.
    expect((await request(m.app).put(`/api/matters/${litigation.id}/retention`).set('Cookie', iris).send({ retention_class_id: null })).status).toBe(403);
    expect((await request(m.app).put(`/api/matters/${litigation.id}/retention`).set('Cookie', theo).send({ retention_class_id: null })).body.matter.retention_class_id).toBeNull();
  });

  it('due documents: past their period, not on hold — the seeded 2017 letters, not the held delivery notes', async () => {
    const m = await testModule();
    const admin = await m.login('admin');
    const due = (await request(m.app).get('/api/retention/due').set('Cookie', admin)).body.documents as DueDocument[];
    expect(due.map((d) => [d.title, d.retention_end, d.due_from])).toEqual([['Supplier Correspondence 2017', '2024-12-31', '2025-01-01']]);
    expect((await request(m.app).get('/api/retention/due').set('Cookie', await m.login('theo'))).status).toBe(403);
    // Before 1 January 2025 they were not due yet.
    m.clock.now = Date.parse('2024-12-31T12:00:00Z');
    expect((await request(m.app).get('/api/retention/due').set('Cookie', admin)).body.documents).toEqual([]);
  });

  it('a legal hold blocks disposal whatever the date says; releasing it is recorded', async () => {
    const m = await testModule();
    const [admin, theo] = await Promise.all([m.login('admin'), m.login('theo')]);
    const held = (m.db.prepare("SELECT id FROM documents WHERE title = 'Delivery Notes 2017'").get() as { id: number }).id;
    const dispose = () => request(m.app).post(`/api/documents/${held}/dispose`).set('Cookie', admin).send({ confirm: true });
    expect((await dispose()).body.error).toBe('The document is on legal hold');
    expect((await request(m.app).post(`/api/documents/${held}/legal-hold`).set('Cookie', theo).send({ reason: 'again' })).status).toBe(409);
    const released = await request(m.app).delete(`/api/documents/${held}/legal-hold`).set('Cookie', theo);
    expect(released.body.retention).toMatchObject({ legal_hold: null, due: true });
    const set = await request(m.app).post(`/api/documents/${held}/legal-hold`).set('Cookie', theo).send({ reason: 'Betriebsprüfung 2026' });
    expect(set.body.retention.legal_hold).toMatchObject({ reason: 'Betriebsprüfung 2026', by_name: 'Theo Brandt' });
    const events = (await request(m.app).get(`/api/documents/${held}`).set('Cookie', theo)).body.events as { kind: string; detail: string }[];
    expect(events.slice(0, 2)).toMatchObject([
      { kind: 'hold_set', detail: 'Betriebsprüfung 2026' },
      { kind: 'hold_released', detail: 'Evidence in the pending Northwind proceedings' },
    ]);
  });

  it('disposal: by an administrator, confirmed, only when due — and then everything goes but the record', async () => {
    const platform = recordingPlatform();
    const m = await testModule({ platform });
    const [admin, theo] = await Promise.all([m.login('admin'), m.login('theo')]);
    const litigation = await m.matter(theo, 'MAT-2026-021');
    // Not due: kept until the end of 2033.
    const fresh = await m.upload(theo, litigation.id, Buffer.from('Neu'), 'Neu', 'neu.txt', 'text/plain');
    expect((await request(m.app).post(`/api/documents/${fresh.body.document.id}/dispose`).set('Cookie', admin).send({ confirm: true })).body.error).toBe(
      'The document must be kept until 2033-12-31; it may be disposed of from 2034-01-01',
    );

    const due = (m.db.prepare("SELECT id FROM documents WHERE title = 'Supplier Correspondence 2017'").get() as { id: number }).id;
    // A second document with the very same bytes shares its stored file.
    const bytes = m.db.prepare('SELECT storage_path FROM document_versions WHERE document_id = ?').get(due) as { storage_path: string };
    const twin = await m.upload(theo, litigation.id, (await import('node:fs')).readFileSync(`${m.storageDir}/${bytes.storage_path}`), 'Kopie', 'kopie.txt', 'text/plain');
    const link = await request(m.app).post(`/api/documents/${due}/shares`).set('Cookie', theo).send({});
    expect(link.status).toBe(201);

    expect((await request(m.app).post(`/api/documents/${due}/dispose`).set('Cookie', theo).send({ confirm: true })).status).toBe(403);
    expect((await request(m.app).post(`/api/documents/${due}/dispose`).set('Cookie', admin).send({})).status).toBe(422);
    const filesBefore = readdirSync(m.storageDir).length;
    const res = await request(m.app).post(`/api/documents/${due}/dispose`).set('Cookie', admin).send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.disposal).toMatchObject({
      document_id: due,
      matter_key: 'MAT-2026-021',
      retention_class: 'AT — books, records and vouchers',
      years: 7,
      document_date: '2017-09-14',
      retention_end: '2024-12-31',
      versions: 1,
      files_removed: 0, // the twin still uses the file
      mirrors: { search: 'removed', files: 'failed' },
      disposed_by_name: 'Dana Ellis',
    });
    expect(platform.removed).toEqual([{ docId: due, versions: [1] }]);

    // Gone: the document, its versions, text, links, history, search entry.
    expect((await request(m.app).get(`/api/documents/${due}`).set('Cookie', admin)).status).toBe(404);
    for (const table of ['document_versions', 'document_tags', 'document_events', 'share_links']) {
      expect((m.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE document_id = ?`).get(due) as { n: number }).n, table).toBe(0);
    }
    expect(m.db.prepare('SELECT 1 FROM document_search WHERE rowid = ?').get(due)).toBeUndefined();
    expect((await request(m.app).get(`/api/shared/${link.body.token}`)).status).toBe(404);
    expect(readdirSync(m.storageDir).length).toBe(filesBefore);
    // The record names no title and carries no content.
    const record = JSON.stringify(m.db.prepare('SELECT * FROM disposals').all());
    expect(record).not.toContain('Supplier Correspondence');
    expect((await request(m.app).get('/api/disposals').set('Cookie', admin)).body.disposals).toHaveLength(1);

    // Now the twin is the last user of the file: disposing it removes the file.
    m.db.prepare("UPDATE documents SET retention_class_id = (SELECT id FROM retention_classes WHERE years = 6), document_date = '2015-01-01' WHERE id = ?").run(twin.body.document.id);
    const second = await request(m.app).post(`/api/documents/${twin.body.document.id}/dispose`).set('Cookie', admin).send({ confirm: true });
    expect(second.body.disposal.files_removed).toBe(1);
    expect(existsSync(`${m.storageDir}/${bytes.storage_path}`)).toBe(false);
  });

  it('a soft-deleted document still has its bytes, so it is still disposed of when due', async () => {
    const m = await testModule();
    const [admin, theo] = await Promise.all([m.login('admin'), m.login('theo')]);
    const due = (m.db.prepare("SELECT id FROM documents WHERE title = 'Supplier Correspondence 2017'").get() as { id: number }).id;
    await request(m.app).delete(`/api/documents/${due}`).set('Cookie', theo).expect(200);
    const list = (await request(m.app).get('/api/retention/due').set('Cookie', admin)).body.documents as DueDocument[];
    expect(list).toMatchObject([{ id: due, deleted: true }]);
    expect((await request(m.app).post(`/api/documents/${due}/dispose`).set('Cookie', admin).send({ confirm: true })).status).toBe(200);
  });
});
