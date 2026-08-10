/**
 * The public download route serves caller-supplied bytes under a
 * caller-supplied content type. Regression cover for the stored-XSS hole that
 * left open: an object uploaded as `text/html` was rendered inline on PS-06's
 * own origin by anyone holding a signed URL.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { attachmentFilename } from '../server/storage.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const svc = { 'X-Service-Token': 'test-service' };
const signingSecret = 'sign-secret';
const b64 = (s: string) => Buffer.from(s).toString('base64');

let db: Database.Database;
let app: Express;
let clock: number;

beforeEach(async () => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  app = createApp({ db, auth, signingSecret, now: () => clock });
  await request(app).post('/api/buckets').set(svc).send({ name: 'docs' }).expect(201);
});

async function store(key: string, content: string, contentType: string): Promise<string> {
  await request(app)
    .put(`/api/objects/docs/${encodeURIComponent(key)}`)
    .set(svc)
    .send({ content_base64: b64(content), content_type: contentType })
    .expect(201);
  const signed = await request(app)
    .post(`/api/objects/docs/${encodeURIComponent(key)}/sign`)
    .set(svc)
    .send({})
    .expect(200);
  return signed.body.url as string;
}

describe('public download hardening', () => {
  it('never renders an uploaded object inline, whatever type it claims', async () => {
    const url = await store('evil.html', '<script>alert(1)</script>', 'text/html');
    const res = await request(app).get(url).expect(200);

    // An attachment is downloaded, not executed — regardless of the type.
    expect(res.headers['content-disposition']).toBe('attachment; filename="evil.html"');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The bytes and the declared type still round-trip intact.
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toBe('<script>alert(1)</script>');
  });

  it('hardens svg and xhtml, the other types browsers execute script in', async () => {
    for (const type of ['image/svg+xml', 'application/xhtml+xml']) {
      const res = await request(app).get(await store(`x-${type.replace(/\W/g, '')}`, '<svg/>', type)).expect(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    }
  });

  it('keeps a hostile key out of the Content-Disposition header', () => {
    // A quote would otherwise end the quoted string and let the key inject
    // further header parameters.
    expect(attachmentFilename('a/b/re"port.pdf')).toBe('report.pdf');
    expect(attachmentFilename('nested/path/file.txt')).toBe('file.txt');
    expect(attachmentFilename('trailing/')).toBe('trailing');
    expect(attachmentFilename('"')).toBe('download');
  });
});
