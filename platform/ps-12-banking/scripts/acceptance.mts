/**
 * Acceptance run of docs/TEST-PLAN-PS-12.md — the L cases.
 *
 * This is not the unit suite run again. Each case drives the service's own
 * HTTP routes the way the plan says an operator would, and reports PASS/FAIL
 * with the evidence the plan asks for.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '/home/user/0815software/platform/ps-12-banking/server/app.js';
import { openDb } from '/home/user/0815software/platform/ps-12-banking/server/db.js';
import { Transport } from '/home/user/0815software/platform/ps-12-banking/server/transport.js';
import { sqliteRecorder } from '/home/user/0815software/platform/ps-12-banking/server/exchanges.js';
import { verifyChain, chainHead } from '/home/user/0815software/platform/ps-12-banking/server/chain.js';
import { MockBank } from '/home/user/0815software/platform/ps-12-banking/test/mock-bank.js';

const AUTH = { username: 'admin', password: 'pw', secret: 's'.repeat(16), ttlHours: 12,
  secureCookie: false, serviceToken: 'svc' };
const KEY_SECRET = '5a'.repeat(32);
const BTF = { service_name: 'SCT', scope: 'AT', msg_name: 'pain.001', msg_version: '03', container: 'XML' };

const results: { id: string; title: string; ok: boolean; note: string }[] = [];
function record(id: string, title: string, ok: boolean, note: string) {
  results.push({ id, title, ok, note });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${note ? ' — ' + note : ''}`);
}

function pain001(msgId: string, total = '10.00', count = 1): string {
  const each = (Number(total) / count).toFixed(2);
  const tx = Array.from({ length: count }, (_u, i) =>
    `<CdtTrfTxInf><PmtId><EndToEndId>E2E-${i}</EndToEndId></PmtId>` +
    `<Amt><InstdAmt Ccy="EUR">${each}</InstdAmt></Amt><Cdtr><Nm>C${i}</Nm></Cdtr></CdtTrfTxInf>`).join('');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>` +
    `<GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>2026-08-20T10:00:00</CreDtTm><NbOfTxs>${count}</NbOfTxs>` +
    `<CtrlSum>${total}</CtrlSum><InitgPty><Nm>D</Nm></InitgPty></GrpHdr>` +
    `<PmtInf><PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd>${tx}</PmtInf>` +
    `</CstmrCdtTrfInitn></Document>`, 'utf8').toString('base64');
}

interface Rig { app: ReturnType<typeof createApp>; db: ReturnType<typeof openDb>; bank: MockBank; token: string }

async function rig(over: Record<string, unknown> = {}, post?: (u: string, b: string) => Promise<{ status: number; body: string }>): Promise<Rig> {
  const db = openDb(':memory:');
  const bank = new MockBank();
  const app = createApp({ db, auth: AUTH as never, keySecret: KEY_SECRET,
    transport: new Transport({ post: post ?? (async (_u, b) => bank.post(b)), record: sqliteRecorder(db) }) });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  const token = login.body.token as string;
  const as = (m: 'post' | 'get', p: string) => request(app)[m](p).set('Authorization', `Bearer ${token}`);
  await as('post', '/api/connections').send({ key: 'main', display_name: 'T', bank_key: 'at-sepa',
    url: 'https://bank.example/ebics', host_id: bank.hostId, partner_id: 'P1', user_id: 'U1', ...over });
  return { app, db, bank, token };
}

const as = (r: Rig, m: 'post' | 'get', p: string) => request(r.app)[m](p).set('Authorization', `Bearer ${r.token}`);

async function toReady(r: Rig): Promise<void> {
  await as(r, 'post', '/api/connections/main/keys');
  await as(r, 'post', '/api/connections/main/ini');
  await as(r, 'post', '/api/connections/main/hia');
  const hpb = await as(r, 'post', '/api/connections/main/hpb');
  const d = (p: string) => (hpb.body.bank_keys as { purpose: string; digestFormatted: string }[])
    .find((k) => k.purpose === p)!.digestFormatted;
  await as(r, 'post', '/api/connections/main/verify-bank-keys').send({ auth_digest: d('AUTH'), enc_digest: d('ENC') });
}

// ── 1 · Key lifecycle ──────────────────────────────────────────────────

async function areaA() {
  console.log('\n1 · Key lifecycle and custody');

  // A1 — the INI letter is a real PDF carrying the right identifiers.
  {
    const r = await rig();
    await as(r, 'post', '/api/connections/main/keys');
    const res = await as(r, 'get', '/api/connections/main/ini-letter.pdf');
    const pdf = res.body as Buffer;
    const text = pdf.toString('latin1');
    const structural = res.status === 200 && text.startsWith('%PDF-') && text.trimEnd().endsWith('%%EOF')
      && /\/Type\s*\/Catalog/.test(text) && /trailer/.test(text);
    const identifiers = [r.bank.hostId, 'P1', 'U1'].every((v) => text.includes(v));
    record('A1', 'INI letter is a structurally valid PDF naming Host/Partner/User',
      structural && identifiers,
      structural && identifiers ? `${pdf.length} bytes; human step (open in a PDF reader) still outstanding`
        : `structural=${structural} identifiers=${identifiers}`);
    r.db.close();
  }

  // A2 — every digest on the paper equals the digest in the store.
  {
    const r = await rig();
    await as(r, 'post', '/api/connections/main/keys');
    const text = ((await as(r, 'get', '/api/connections/main/ini-letter.pdf')).body as Buffer).toString('latin1');
    const stored = r.db.prepare('SELECT purpose, digest FROM subscriber_keys').all() as
      { purpose: string; digest: string }[];
    // The letter prints the EBICS digest as UPPERCASE HEX in eight-character
    // groups (keystore.formatForLetter), split across two text runs so it fits
    // the box. So: pull the text runs out of the PDF, keep only hex, and look
    // for the whole 64-character digest.
    const runs = [...text.matchAll(/\((.*?)\)\s*Tj/g)].map((m) => m[1]).join('');
    const hexOnly = runs.replace(/[^0-9A-F]/g, '');
    const missing = stored.filter(
      (k) => !hexOnly.includes(Buffer.from(k.digest, 'base64').toString('hex').toUpperCase()),
    );
    record('A2', 'each stored digest appears on the letter', stored.length === 3 && missing.length === 0,
      missing.length ? `missing: ${missing.map((m) => m.purpose).join(', ')}` : `${stored.length} digests matched`);
    r.db.close();
  }

  // A3 — no order before a human verified the bank's keys; a wrong digest is refused.
  {
    const r = await rig();
    await as(r, 'post', '/api/connections/main/keys');
    await as(r, 'post', '/api/connections/main/ini');
    await as(r, 'post', '/api/connections/main/hia');
    const hpb = await as(r, 'post', '/api/connections/main/hpb');
    const before = await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('A3-1') });
    const wrong = await as(r, 'post', '/api/connections/main/verify-bank-keys')
      .send({ auth_digest: 'AAAA BBBB', enc_digest: 'CCCC DDDD' });
    const stillNotReady = (await as(r, 'get', '/api/connections/main')).body.state !== 'ready';
    const d = (p: string) => (hpb.body.bank_keys as { purpose: string; digestFormatted: string }[])
      .find((k) => k.purpose === p)!.digestFormatted;
    const right = await as(r, 'post', '/api/connections/main/verify-bank-keys')
      .send({ auth_digest: d('AUTH'), enc_digest: d('ENC') });
    const ready = (await as(r, 'get', '/api/connections/main')).body.state === 'ready';
    record('A3', 'bank keys are not trusted until a human confirms them',
      before.status === 409 && wrong.status >= 400 && stillNotReady && right.status === 200 && ready,
      `order before verification ${before.status}, wrong digest ${wrong.status}, then ready=${ready}`);
    r.db.close();
  }

  // A4 — a lock is one-way.
  {
    const r = await rig();
    await toReady(r);
    const lock = await as(r, 'post', '/api/connections/main/lock').send({ reason: 'suspected compromise' });
    const state = (await as(r, 'get', '/api/connections/main')).body.state;
    const resume = await as(r, 'post', '/api/connections/main/resume');
    const clear = await as(r, 'post', '/api/connections/main/clear-failure');
    const after = (await as(r, 'get', '/api/connections/main')).body.state;
    record('A4', 'a locked subscriber cannot be resumed or cleared from here',
      lock.status === 200 && state === 'locked' && resume.status >= 400 && clear.status >= 400 && after === 'locked',
      `lock ${lock.status}, resume ${resume.status}, clear ${clear.status}, state ${after}`);
    r.db.close();
  }
}

// ── 2 · Upload and orders ──────────────────────────────────────────────

async function areaB() {
  console.log('\n2 · Upload and orders');

  // B3 — a ceiling is enforced before anything is signed or sent.
  {
    const r = await rig({ max_amount_minor: 500 });
    await toReady(r);
    const before = (r.db.prepare('SELECT COUNT(*) AS n FROM bank_exchanges').get() as { n: number }).n;
    const res = await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('B3-1', '10.00') });
    const after = (r.db.prepare('SELECT COUNT(*) AS n FROM bank_exchanges').get() as { n: number }).n;
    const orders = (r.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
    record('B3', 'a ceiling refuses before signing, and nothing reaches the bank',
      res.status === 422 && after === before && orders === 0,
      `${res.status}, exchanges ${before}→${after}, orders ${orders}`);
    r.db.close();
  }

  // B4 — the same file is one payment, with and without an idempotency key.
  {
    const r = await rig();
    await toReady(r);
    const send = (body: Record<string, unknown>) => request(r.app).post('/api/orders')
      .set('X-Service-Token', 'svc').send(body);
    const base = { connection: 'main', btf: BTF, payload_base64: pain001('B4-1') };
    const first = await send({ ...base, idempotency_key: 'run:B4' });
    const second = await send({ ...base, idempotency_key: 'run:B4' });
    const third = await send(base); // same MsgId, no key at all
    const orders = (r.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
    // A replay is signalled by 200 rather than 201, and returns the SAME order.
    const sameId = first.body.public_id === second.body.public_id
      && first.body.public_id === third.body.public_id;
    record('B4', 'one file is one order, on the key and on the MsgId',
      first.status === 201 && second.status === 200 && third.status === 200 && sameId && orders === 1,
      `first ${first.status}, key replay ${second.status}, no-key replay ${third.status}, orders ${orders}`);
    r.db.close();
  }
}

// ── 3 · Downloads ──────────────────────────────────────────────────────

async function areaC() {
  console.log('\n3 · Downloads and subscriptions');

  // C3 — a format nothing parses is stored whole, not dropped.
  {
    const r = await rig();
    await toReady(r);
    const odd = '<SomeFormatNobodyHereReads xmlns="urn:example:unknown"><X>1</X></SomeFormatNobodyHereReads>';
    r.bank.enqueue({ serviceName: 'ZZZ', msgName: 'xyz.999' }, odd);
    const fetched = await as(r, 'post', '/api/connections/main/fetch')
      .send({ btf: { service_name: 'ZZZ', msg_name: 'xyz.999', container: 'XML' } });
    const list = (await as(r, 'get', '/api/downloads')).body.downloads as { public_id: string; kind: string }[];
    const content = list.length
      ? await as(r, 'get', `/api/downloads/${list[0]!.public_id}/content`) : null;
    record('C3', 'an unreadable format is stored whole and stays downloadable',
      fetched.status === 200 && list.length === 1 && list[0]!.kind === 'other'
        && String(content?.text ?? content?.body).includes('SomeFormatNobodyHereReads'),
      `fetch ${fetched.status}, kind "${list[0]?.kind}", bytes recoverable`);
    r.db.close();
  }
}

// ── 6 · Traceability ───────────────────────────────────────────────────

async function areaF() {
  console.log('\n6 · Traceability');

  // F3 — the request that never came back.
  {
    const r = await rig({}, () => Promise.reject(new Error('connection reset by peer')));
    // The lifecycle needs the bank, so build a ready connection on a working
    // rig first, then swap the transport by using a second rig for the send.
    // Simpler: use a transport that works until the order, then fails.
    r.db.close();
    let live = true;
    const bank = new MockBank();
    const db = openDb(':memory:');
    const app = createApp({ db, auth: AUTH as never, keySecret: KEY_SECRET,
      transport: new Transport({ record: sqliteRecorder(db),
        post: async (_u, b) => { if (!live) throw new Error('connection reset by peer'); return bank.post(b); } }) });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
    const rr: Rig = { app, db, bank, token: login.body.token };
    await as(rr, 'post', '/api/connections').send({ key: 'main', display_name: 'T', bank_key: 'at-sepa',
      url: 'https://bank.example/ebics', host_id: bank.hostId, partner_id: 'P1', user_id: 'U1' });
    await toReady(rr);
    live = false;
    const res = await request(app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('F3-1') });
    const id = res.body.public_id as string;
    const ex = (await as(rr, 'get', `/api/orders/${id}/exchanges`)).body.exchanges as
      { id: number; error: string | null; response_bytes: number | null; phase: string }[];
    const detail = ex.length ? (await as(rr, 'get', `/api/exchanges/${ex[0]!.id}`)).body : null;
    record('F3', 'an unanswered upload keeps the request that was sent',
      res.status === 201 && res.body.status === 'failed' && ex.length === 1 && ex[0]!.error !== null
        && ex[0]!.response_bytes === null && String(detail?.request).includes('ebicsRequest'),
      `HTTP ${res.status}, status ${res.body.status}, ${ex.length} exchange, error "${ex[0]?.error}"`);
    db.close();
  }

  // F4 — the log is not a credential store.
  {
    const r = await rig();
    await toReady(r);
    await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('F4-1') });
    const rows = r.db.prepare('SELECT request, response FROM bank_exchanges').all() as
      { request: string; response: string | null }[];
    const leak = rows.some((x) => /PRIVATE KEY|BEGIN RSA/.test(x.request + (x.response ?? '')));
    record('F4', 'no stored envelope carries private key material', rows.length > 0 && !leak,
      `${rows.length} exchanges scanned`);
    r.db.close();
  }

  // F5 — retention does not adopt somebody else's deletion.
  {
    const r = await rig();
    await toReady(r);
    await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('F5-1') });
    r.db.prepare("DELETE FROM bank_exchanges WHERE phase = 'order.initialisation'").run();
    const caught = verifyChain(r.db);
    const { pruneExchanges } = await import('/home/user/0815software/platform/ps-12-banking/server/exchanges.js');
    const pruned = pruneExchanges(r.db, 730, () => new Date().toISOString());
    const after = verifyChain(r.db);
    const marked = (r.db.prepare('SELECT COUNT(*) AS n FROM event_chain WHERE pruned_at IS NOT NULL')
      .get() as { n: number }).n;
    record('F5', 'a tick does not launder a hand-deletion green',
      caught.broken_kind === 'missing' && pruned === 0 && after.valid === false
        && after.broken_kind === 'missing' && marked === 0,
      `before "${caught.broken_kind}", pruned ${pruned}, after "${after.broken_kind}", marked ${marked}`);
    r.db.close();
  }
}

// ── 7 · Audit chain ────────────────────────────────────────────────────

async function areaG() {
  console.log('\n7 · Audit chain');

  // G1 — an edited event is caught and named.
  {
    const r = await rig();
    await toReady(r);
    await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('G1-1') });
    r.db.prepare("UPDATE order_events SET type = 'settled' WHERE type = 'queued'").run();
    const v = (await as(r, 'get', '/api/audit/chain')).body;
    record('G1', 'an edited order event breaks the chain, and the verdict names it',
      v.valid === false && v.broken_kind === 'content' && String(v.message).includes('order_events'),
      `${v.broken_kind}: ${v.message}`);
    r.db.close();
  }

  // G2 — the cheap pass admits what it did not check.
  {
    const r = await rig();
    await toReady(r);
    await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('G2-1') });
    r.db.prepare("UPDATE order_events SET type = 'settled' WHERE type = 'queued'").run();
    const quick = (await as(r, 'get', '/api/audit/chain?quick=1')).body;
    const full = (await as(r, 'get', '/api/audit/chain')).body;
    const metrics = (await request(r.app).get('/api/metrics')).text;
    record('G2', 'the quick pass says content_checked:false and the gauge says so too',
      quick.valid === true && quick.content_checked === false && full.valid === false
        && full.content_checked === true && metrics.includes('cheap pass only'),
      `quick valid=${quick.valid} checked=${quick.content_checked}; full valid=${full.valid}`);
    r.db.close();
  }

  // G5 — the head survives a restart, on a real file.
  {
    const dir = mkdtempSync(join(tmpdir(), 'ps12-accept-'));
    const path = join(dir, 'data.db');
    try {
      const bank = new MockBank();
      const db = openDb(path);
      const app = createApp({ db, auth: AUTH as never, keySecret: KEY_SECRET,
        transport: new Transport({ post: async (_u, b) => bank.post(b), record: sqliteRecorder(db) }) });
      const login = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
      const rr: Rig = { app, db, bank, token: login.body.token };
      await as(rr, 'post', '/api/connections').send({ key: 'main', display_name: 'T', bank_key: 'at-sepa',
        url: 'https://bank.example/ebics', host_id: bank.hostId, partner_id: 'P1', user_id: 'U1' });
      await toReady(rr);
      const head = chainHead(db);
      const links = (db.prepare('SELECT COUNT(*) AS n FROM event_chain').get() as { n: number }).n;
      db.close();

      const again = openDb(path);
      const v = verifyChain(again);
      const sameHead = chainHead(again) === head;
      const sameLinks = (again.prepare('SELECT COUNT(*) AS n FROM event_chain').get() as { n: number }).n === links;
      record('G5', 'the head and the chain survive stop/start on a file database',
        v.valid && sameHead && sameLinks, `${links} links, head ${String(head).slice(0, 12)}…`);
      again.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

// ── 5 · The fold ───────────────────────────────────────────────────────

async function areaE() {
  console.log('\n5 · Status (the fold itself)');
  const { foldStatus } = await import('/home/user/0815software/platform/ps-12-banking/server/orders.js');
  const st = (...types: string[]) =>
    foldStatus(types.map((type) => ({ type, ebics_code: null, meta: {}, actor: null, created_at: '' })) as never);

  // E2 — the contradiction is terminal, whichever way round it arrives.
  {
    const settledThenReturned = st('queued', 'accepted', 'settled', 'rejected');
    const refusedThenSettled = st('queued', 'accepted', 'rejected', 'settled');
    const thirdAnswer = st('accepted', 'settled', 'rejected', 'settled');
    record('E2', 'two opposite answers fold to contested, and a third does not resolve it',
      settledThenReturned === 'contested' && refusedThenSettled === 'contested' && thirdAnswer === 'contested',
      `settled→rejected "${settledThenReturned}", rejected→settled "${refusedThenSettled}", +third "${thirdAnswer}"`);
  }

  // E3 — the ordinary paths must be untouched, or the status is noise.
  {
    const normalRefusal = st('queued', 'initialised', 'transferred', 'accepted', 'rejected');
    const normalSettle = st('queued', 'accepted', 'settled');
    const unknownThenSettled = st('queued', 'initialised', 'failed', 'settled');
    const unknownThenRefused = st('queued', 'initialised', 'failed', 'rejected');
    record('E3', 'accepted→rejected and failed→anything stay ordinary',
      normalRefusal === 'rejected' && normalSettle === 'settled'
        && unknownThenSettled === 'settled' && unknownThenRefused === 'rejected',
      `${normalRefusal} / ${normalSettle} / ${unknownThenSettled} / ${unknownThenRefused}`);
  }
}

// ── 10 · Operations ────────────────────────────────────────────────────

async function areaJ() {
  console.log('\n10 · Operations');

  // J1 — a fresh install comes up clean.
  {
    const r = await rig();
    const migrations = r.db.prepare('SELECT id, name FROM schema_migrations').all() as { id: number; name: string }[];
    const tables = (r.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
      .get() as { n: number }).n;
    const ready = await request(r.app).get('/api/ready');
    const v = verifyChain(r.db);
    record('J1', 'one baseline migration, 16 tables, ready, chain valid',
      migrations.length === 1 && migrations[0]!.name === 'baseline' && tables === 16
        && ready.status === 200 && ready.body.ready === true && v.valid,
      `${migrations.length} migration(s), ${tables} tables, ready=${ready.body.ready}, chain ${v.count} links`);
    r.db.close();
  }

  // J8 — the egress guard refuses an internal bank URL, and records the refusal.
  {
    const db = openDb(':memory:');
    const bank = new MockBank();
    const app = createApp({ db, auth: AUTH as never, keySecret: KEY_SECRET,
      transport: new Transport({ post: async (_u, b) => bank.post(b), record: sqliteRecorder(db),
        egress: { mode: 'block', allowHosts: new Set<string>() } }) });
    const login = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
    const rr: Rig = { app, db, bank, token: login.body.token };
    await as(rr, 'post', '/api/connections').send({ key: 'main', display_name: 'T', bank_key: 'at-sepa',
      url: 'http://127.0.0.1:4001/ebics', host_id: bank.hostId, partner_id: 'P1', user_id: 'U1' });
    await as(rr, 'post', '/api/connections/main/keys');
    const ini = await as(rr, 'post', '/api/connections/main/ini');
    const ex = db.prepare('SELECT phase, error FROM bank_exchanges').all() as { phase: string; error: string }[];
    record('J8', 'an internal bank URL is refused, and the refusal is on the record',
      ini.status >= 400 && ex.length === 1 && /egress/.test(ex[0]!.error ?? ''),
      `${ini.status}; recorded "${ex[0]?.error ?? 'nothing'}"`);
    db.close();
  }

  // J9 — the credential line.
  {
    const r = await rig();
    await toReady(r);
    const ord = await request(r.app).post('/api/orders').set('X-Service-Token', 'svc')
      .send({ connection: 'main', btf: BTF, payload_base64: pain001('J9-1') });
    const id = ord.body.public_id as string;
    const svc = (p: string) => request(r.app).get(p).set('X-Service-Token', 'svc');
    const none = (p: string) => request(r.app).get(p);
    const mayRead = (await svc(`/api/orders/${id}`)).status;
    const denied = await Promise.all(['/api/exchanges', '/api/audit/chain', '/api/audit/head',
      `/api/orders/${id}/exchanges`, '/api/connections'].map(async (p) => (await svc(p)).status));
    const anon = await Promise.all(['/api/exchanges', '/api/audit/chain'].map(async (p) => (await none(p)).status));
    record('J9', 'a module may pay and read its order, and nothing else',
      ord.status === 201 && mayRead === 200 && denied.every((s) => s === 403) && anon.every((s) => s === 401),
      `order read ${mayRead}, service-token elsewhere ${denied.join('/')}, anonymous ${anon.join('/')}`);
    r.db.close();
  }
}

async function main() {
  await areaA();
  await areaB();
  await areaC();
  await areaE();
  await areaF();
  await areaG();
  await areaJ();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} cases run, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.id).join(', ')); process.exitCode = 1; }
}
await main();
