/**
 * Off-site backups: deploy/backup.mjs and its libraries.
 *
 * What a backup is for is the day the host is gone, so the suite plays that
 * day out: a stack is backed up to a folder target and an S3 target, the
 * archive is fetched back and decrypted, and a brand-new, empty stack folder
 * is restored from it — databases written into the volumes, stale WAL files
 * removed, files folders back, .env back. Docker and sftp are replaced by
 * fixtures (test/fixtures/fake-*.mjs) because CI has neither; the code the
 * tool sends INTO containers runs for real.
 *
 * Also pinned: the encryption fails closed (wrong passphrase, one flipped
 * byte, a truncated file), retention never deletes the newest archive nor a
 * file that is not this stack's, the S3 signer matches AWS's published
 * examples, and a backup that only partly worked says so — exit status,
 * status file and alert.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveName,
  checkConfig,
  parseArchiveName,
  restore,
  runBackup,
  stackNameOf,
  verifyBackups,
} from '../backup.mjs';
import { decryptFile, encryptFile } from '../lib/backup-crypto.mjs';
import { loadConfig, parseEnvFile, renderConfig } from '../lib/backup-config.mjs';
import { _test as retentionKeys, selectRetained } from '../lib/backup-retention.mjs';
import { openTarget } from '../lib/backup-targets.mjs';
import { signV4 } from '../lib/s3.mjs';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
const PASSPHRASE = 'correct-horse-battery-staple-42';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

const fakeDb = (label: string) => Buffer.concat([SQLITE_HEADER, Buffer.from(`${label}:${randomBytes(8).toString('hex')}`)]);

let tmp: string;
const savedPath = process.env.PATH;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backup-offsite-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, 'fake-docker.mjs')}" "$@"\n`);
  writeFileSync(join(bin, 'sftp'), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, 'fake-sftp.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'sftp'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.FAKE_DOCKER_ROOT = join(tmp, 'containers');
  for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_')) delete process.env[k];
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(tmp, { recursive: true, force: true });
});

/** Containers: ps11 (database), mod09 (database + uploaded files), caddy (no Node, no data). */
function makeContainers({ failMod09 = false } = {}) {
  const root = join(tmp, 'containers');
  mkdirSync(join(root, 'ps11', 'data'), { recursive: true });
  mkdirSync(join(root, 'mod09', 'data', 'storage', 'a'), { recursive: true });
  const dbs = { ps11: fakeDb('ps11'), mod09: fakeDb('mod09') };
  writeFileSync(join(root, 'ps11', 'data', 'data.db'), dbs.ps11);
  writeFileSync(join(root, 'mod09', 'data', 'data.db'), dbs.mod09);
  writeFileSync(join(root, 'mod09', 'data', 'storage', 'a', 'contract.pdf'), 'PDF-1');
  for (const svc of ['ps11', 'mod09']) {
    mkdirSync(join(root, svc, 'app', 'scripts'), { recursive: true });
    writeFileSync(join(root, svc, 'app', 'scripts', 'backup.mjs'), '// real one lives in the package');
  }
  writeFileSync(
    join(root, 'services.json'),
    JSON.stringify({
      ps11: { running: true, node: true, script: true },
      mod09: { running: true, node: true, script: true, fail: failMod09, env: { STORAGE_DIR: '/data/storage' } },
      caddy: { running: true, node: false },
    }),
  );
  return { root, dbs };
}

function makeStack(name: string, backupEnv: Record<string, string>) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(dir, '.env'), 'PS01_SESSION_SECRET=s3cr3t-from-the-old-host\n');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ customer: 'blaustern' }));
  writeBackupEnv(dir, backupEnv);
  return dir;
}

function writeBackupEnv(dir: string, values: Record<string, string>) {
  writeFileSync(join(dir, 'backup.env'), renderConfig({ BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_ALLOW_SAME_DISK: 'yes', ...values }));
}

function makeFolderTarget(name = 'nas') {
  const dir = join(tmp, name);
  mkdirSync(dir);
  return dir;
}

/** Decrypt and unpack an archive file; returns the folder it was unpacked into. */
async function unpack(archive: string) {
  const out = mkdtempSync(join(tmp, 'unpacked-'));
  await decryptFile(archive, join(out, 'a.tar.gz'), PASSPHRASE);
  execFileSync('tar', ['-xzf', join(out, 'a.tar.gz'), '-C', out]);
  return out;
}

// ── fake S3 + alert receiver ────────────────────────────────────────────────

interface Fake {
  url: string;
  objects: Map<string, Buffer>;
  alerts: unknown[];
  heartbeats: number;
  badSignatures: number;
  close: () => Promise<void>;
}

const S3_CREDS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-key', region: 'eu-central-1' };

async function startFakeServer(): Promise<Fake> {
  const fake = { objects: new Map<string, Buffer>(), alerts: [] as unknown[], heartbeats: 0, badSignatures: 0 } as Fake;
  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => res(Buffer.concat(chunks)));
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const data = await body(req);
    if (url.pathname === '/alert') {
      fake.alerts.push(JSON.parse(data.toString('utf8')));
      return res.end('ok');
    }
    if (url.pathname === '/heartbeat') {
      fake.heartbeats++;
      return res.end('ok');
    }
    // Every S3 request must carry a signature this side can recompute.
    const auth = String(req.headers.authorization ?? '');
    const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1].split(';') ?? [];
    const headers = Object.fromEntries(signed.map((h) => [h, String(req.headers[h])]));
    const expected = signV4({
      method: req.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      headers,
      payloadHash: String(req.headers['x-amz-content-sha256']),
      ...S3_CREDS,
      amzDate: String(req.headers['x-amz-date']),
    }).authorization;
    if (auth !== expected) {
      fake.badSignatures++;
      res.statusCode = 403;
      return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    }
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    const key = rest.join('/');
    if (bucket !== 'offsite') {
      res.statusCode = 404;
      return res.end('<Error><Code>NoSuchBucket</Code></Error>');
    }
    if (req.method === 'PUT') fake.objects.set(key, data);
    else if (req.method === 'DELETE') fake.objects.delete(key);
    else if (req.method === 'GET' && key) {
      const obj = fake.objects.get(key);
      if (!obj) {
        res.statusCode = 404;
        return res.end('<Error><Code>NoSuchKey</Code></Error>');
      }
      return res.end(obj);
    } else if (req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...fake.objects.keys()].filter((k) => k.startsWith(prefix));
      return res.end(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`,
      );
    }
    res.end('');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  fake.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}

function s3Env(fake: Fake) {
  return {
    BACKUP_S3_ENDPOINT: fake.url,
    BACKUP_S3_REGION: S3_CREDS.region,
    BACKUP_S3_ACCESS_KEY_ID: S3_CREDS.accessKeyId,
    BACKUP_S3_SECRET_ACCESS_KEY: S3_CREDS.secretAccessKey,
  };
}

// ── the nightly run ─────────────────────────────────────────────────────────

describe('backup run → folder target and S3 target', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFakeServer();
  });
  afterEach(async () => fake.close());

  it('puts one encrypted archive holding every database, the files and .env on every target', async () => {
    const { dbs } = makeContainers();
    const nas = makeFolderTarget();
    const stack = makeStack('stack', {
      BACKUP_TARGETS: `${nas} s3://offsite/blaustern`,
      BACKUP_HEARTBEAT_URL: `${fake.url}/heartbeat`,
      ...s3Env(fake),
    });

    writeFileSync(join(stack, 'docker-compose.override.yml'), 'services: {}\n');
    mkdirSync(join(stack, 'node_modules', 'big'), { recursive: true });
    writeFileSync(join(stack, 'notes.txt'), 'not part of the stack');
    const status = await runBackup(stack);
    expect(status.errors).toEqual([]);
    expect(status.ok).toBe(true);
    expect(status.services.backedUp.sort()).toEqual(['mod09', 'ps11']); // caddy holds nothing

    const name = status.archive!.name;
    expect(parseArchiveName('blaustern', name)).not.toBeNull();
    expect(readdirSync(nas)).toEqual([name]);
    expect([...fake.objects.keys()]).toEqual([`blaustern/${name}`]);
    expect(readFileSync(join(nas, name)).equals(fake.objects.get(`blaustern/${name}`)!)).toBe(true);
    expect(fake.badSignatures).toBe(0);
    expect(fake.heartbeats).toBe(1);

    // Encrypted: none of the data is readable on the target.
    const raw = readFileSync(join(nas, name));
    expect(raw.includes(SQLITE_HEADER)).toBe(false);
    expect(raw.includes(Buffer.from('s3cr3t-from-the-old-host'))).toBe(false);

    const out = await unpack(join(nas, name));
    for (const svc of ['ps11', 'mod09'] as const) {
      const files = readdirSync(join(out, 'services', svc));
      const db = files.find((f) => /^backup-.*\.db$/.test(f))!;
      expect(readFileSync(join(out, 'services', svc, db)).equals(dbs[svc])).toBe(true);
    }
    const storage = readdirSync(join(out, 'services', 'mod09')).find((f) => f.startsWith('storage-'))!;
    expect(readFileSync(join(out, 'services', 'mod09', storage, 'a', 'contract.pdf'), 'utf8')).toBe('PDF-1');
    expect(readFileSync(join(out, 'stack', '.env'), 'utf8')).toContain('s3cr3t-from-the-old-host');
    // The passphrase and target credentials must never travel inside the archive they open.
    expect(existsSync(join(out, 'stack', 'backup.env'))).toBe(false);
    // Only the stack's own files — not whatever else shares its folder.
    expect(readdirSync(join(out, 'stack')).sort()).toEqual(['.env', 'docker-compose.override.yml', 'docker-compose.yml', 'manifest.json']);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toMatchObject({ format: 1, stack: 'blaustern' });

    // Nothing is left behind in the work folder.
    expect(existsSync(join(stack, '.backup-work'))).toBe(false);
    expect(JSON.parse(readFileSync(join(stack, 'backup-status.json'), 'utf8')).ok).toBe(true);
  });

  it('prunes old snapshots on each volume down to BACKUP_KEEP_LOCAL', async () => {
    const { root } = makeContainers();
    const nas = makeFolderTarget();
    const stack = makeStack('stack', { BACKUP_TARGETS: nas, BACKUP_KEEP_LOCAL: '2' });
    for (let i = 0; i < 3; i++) {
      const status = await runBackup(stack, { now: new Date(Date.UTC(2026, 10, 1 + i, 2)) });
      expect(status.ok).toBe(true);
    }
    expect(readdirSync(join(root, 'ps11', 'data', 'backups')).sort()).toEqual(['run-20261102T020000Z', 'run-20261103T020000Z']);
  });

  it('applies retention on the target, and never touches files that are not this stack’s archives', async () => {
    makeContainers();
    const nas = makeFolderTarget();
    // Ninety nightly archives already there, plus things that share the folder.
    for (let d = 0; d < 90; d++) {
      writeFileSync(join(nas, archiveName('blaustern', new Date(Date.UTC(2026, 7, 1 + d, 2)))), 'old');
    }
    writeFileSync(join(nas, 'notes.txt'), 'the office’s own file');
    writeFileSync(join(nas, archiveName('another-customer', new Date(Date.UTC(2025, 0, 1)))), 'not ours');
    const stack = makeStack('stack', {
      BACKUP_TARGETS: nas,
      BACKUP_KEEP_DAILY: '7',
      BACKUP_KEEP_WEEKLY: '4',
      BACKUP_KEEP_MONTHLY: '3',
    });
    const status = await runBackup(stack, { now: new Date(Date.UTC(2026, 10, 7, 2)) });
    expect(status.ok).toBe(true);

    const left = readdirSync(nas);
    expect(left).toContain('notes.txt');
    expect(left).toContain(archiveName('another-customer', new Date(Date.UTC(2025, 0, 1))));
    const ours = left.filter((n) => parseArchiveName('blaustern', n)).sort();
    expect(ours).toContain(status.archive!.name);
    // 7 dailies (today + 6) — the weeks and months they span keep a few more.
    expect(ours.length).toBeGreaterThanOrEqual(7);
    expect(ours.length).toBeLessThanOrEqual(7 + 4 + 3);
    expect(status.targets[nas].removed.length).toBe(91 - ours.length);
  });

  it('a partly failed run still uploads what it has, but exits as a failure and alerts', async () => {
    makeContainers({ failMod09: true });
    const nas = makeFolderTarget();
    const stack = makeStack('stack', {
      BACKUP_TARGETS: `${nas} s3://no-such-bucket/x`,
      BACKUP_ALERT_URL: `${fake.url}/alert`,
      BACKUP_HEARTBEAT_URL: `${fake.url}/heartbeat`,
      ...s3Env(fake),
    });
    const status = await runBackup(stack);
    expect(status.ok).toBe(false);
    expect(status.services.backedUp).toEqual(['ps11']);
    expect(status.errors.join('\n')).toMatch(/snapshot of mod09 failed/);
    expect(status.errors.join('\n')).toMatch(/upload to s3:\/\/no-such-bucket\/x .* failed: .*NoSuchBucket/);
    expect(readdirSync(nas)).toHaveLength(1); // the good half is still kept
    expect(fake.heartbeats).toBe(0);
    expect(fake.alerts).toHaveLength(1);
    expect(fake.alerts[0]).toMatchObject({ status: 'failed', stack: 'blaustern' });
    expect(JSON.stringify(fake.alerts[0])).toContain('mod09');
  });

  it('a failed run also reaches the administrators through PS-03 when the stack runs it', async () => {
    const { root } = makeContainers({ failMod09: true });
    // PS-03 ships scripts/ops-event.mjs (and no backup script in this fixture);
    // the stand-in records what it was asked to send instead of posting it.
    mkdirSync(join(root, 'ps03', 'app', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'ps03', 'app', 'scripts', 'ops-event.mjs'),
      "import { writeFileSync } from 'node:fs'; writeFileSync('../ops-event.json', JSON.stringify(process.argv.slice(2)));",
    );
    const services = JSON.parse(readFileSync(join(root, 'services.json'), 'utf8'));
    writeFileSync(join(root, 'services.json'), JSON.stringify({ ...services, ps03: { running: true, node: true } }));
    const stack = makeStack('stack', { BACKUP_TARGETS: makeFolderTarget() });
    expect((await runBackup(stack)).ok).toBe(false);
    const [kind, title, detail] = JSON.parse(readFileSync(join(root, 'ps03', 'ops-event.json'), 'utf8')) as string[];
    expect(kind).toBe('backup-failed');
    expect(title).toBe('Nightly backup failed');
    expect(detail).toMatch(/snapshot of mod09 failed/);
  });

  it('a successful run sends no ops event', async () => {
    const { root } = makeContainers();
    mkdirSync(join(root, 'ps03', 'app', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'ps03', 'app', 'scripts', 'ops-event.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('../ops-event.json', '[]');");
    const services = JSON.parse(readFileSync(join(root, 'services.json'), 'utf8'));
    writeFileSync(join(root, 'services.json'), JSON.stringify({ ...services, ps03: { running: true, node: true } }));
    const stack = makeStack('stack', { BACKUP_TARGETS: makeFolderTarget() });
    expect((await runBackup(stack)).ok).toBe(true);
    expect(existsSync(join(root, 'ps03', 'ops-event.json'))).toBe(false);
  });

  it('with no target configured, it snapshots locally but fails loudly', async () => {
    makeContainers();
    const stack = makeStack('stack', { BACKUP_TARGETS: '' });
    const status = await runBackup(stack);
    expect(status.ok).toBe(false);
    expect(status.errors[0]).toMatch(/no BACKUP_TARGETS .* will not survive it/);
    expect(status.services.backedUp.length).toBe(2);
    // …unless that is what was asked for.
    expect((await runBackup(stack, { localOnly: true })).ok).toBe(true);
  });

  it('fails when nothing at all could be backed up', async () => {
    const root = join(tmp, 'containers');
    mkdirSync(root);
    writeFileSync(join(root, 'services.json'), JSON.stringify({ caddy: { running: true, node: false } }));
    const stack = makeStack('stack', { BACKUP_TARGETS: makeFolderTarget() });
    const status = await runBackup(stack);
    expect(status.ok).toBe(false);
    expect(status.errors.join()).toMatch(/nothing was backed up/);
  });
});

// ── restore ─────────────────────────────────────────────────────────────────

describe('restore onto a new host', () => {
  it('rebuilds an empty stack folder from the archive: .env back, databases into the volumes, stale WAL gone', async () => {
    const { root, dbs } = makeContainers();
    const nas = makeFolderTarget();
    const oldStack = makeStack('old-host', { BACKUP_TARGETS: nas });
    const status = await runBackup(oldStack);
    expect(status.ok).toBe(true);

    // The old host burns down. The new one starts with containers holding
    // nothing but a stale WAL file, and a stack folder holding only the
    // backup.env the admin typed back in from the password manager.
    rmSync(join(root, 'ps11', 'data'), { recursive: true });
    rmSync(join(root, 'mod09', 'data'), { recursive: true });
    mkdirSync(join(root, 'ps11', 'data'));
    writeFileSync(join(root, 'ps11', 'data', 'data.db-wal'), 'stale wal from a different database');
    const newStack = join(tmp, 'new-host');
    mkdirSync(newStack);
    writeFileSync(join(newStack, 'manifest.json'), JSON.stringify({ customer: 'blaustern' }));
    writeBackupEnv(newStack, { BACKUP_TARGETS: nas });

    await expect(restore(newStack, { apply: true })).rejects.toThrow(/--yes/);

    const unpacked = await restore(newStack, {});
    expect(unpacked.applied).toBe(false);
    expect(readFileSync(join(newStack, '.env'), 'utf8')).toContain('s3cr3t-from-the-old-host');
    expect(statSync(join(newStack, '.env')).mode & 0o077).toBe(0);
    expect(existsSync(join(newStack, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(root, 'ps11', 'data', 'data.db'))).toBe(false); // nothing running was touched

    const applied = await restore(newStack, { apply: true, yes: true });
    expect(applied.applied).toBe(true);
    expect(readFileSync(join(root, 'ps11', 'data', 'data.db')).equals(dbs.ps11)).toBe(true);
    expect(readFileSync(join(root, 'mod09', 'data', 'data.db')).equals(dbs.mod09)).toBe(true);
    expect(existsSync(join(root, 'ps11', 'data', 'data.db-wal'))).toBe(false);
    expect(readFileSync(join(root, 'mod09', 'data', 'storage', 'a', 'contract.pdf'), 'utf8')).toBe('PDF-1');

    const calls = readFileSync(join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const order = calls.map((c: string[]) => c[1]).filter((c: string) => ['stop', 'create', 'run', 'up'].includes(c));
    expect(order).toEqual(['stop', 'create', 'run', 'run', 'up']); // stopped before written, started after
  });

  it('keeps an existing .env and says where the archived one is', async () => {
    makeContainers();
    const nas = makeFolderTarget();
    const stack = makeStack('stack', { BACKUP_TARGETS: nas });
    await runBackup(stack);
    writeFileSync(join(stack, '.env'), 'NEWER=1\n');
    const { dest } = await restore(stack, {});
    expect(readFileSync(join(stack, '.env'), 'utf8')).toBe('NEWER=1\n');
    expect(readFileSync(join(dest, 'stack', '.env'), 'utf8')).toContain('s3cr3t-from-the-old-host');
  });
});

// ── verify and check ────────────────────────────────────────────────────────

describe('verify (the restore drill) and check', () => {
  it('verify decrypts the newest archive and finds real databases; a damaged archive fails it', async () => {
    makeContainers();
    const nas = makeFolderTarget();
    const stack = makeStack('stack', { BACKUP_TARGETS: nas });
    const { archive } = await runBackup(stack);
    await expect(verifyBackups(stack)).resolves.toBeUndefined();

    const path = join(nas, archive!.name);
    const bytes = readFileSync(path);
    bytes[bytes.length - 40] ^= 0x01;
    writeFileSync(path, bytes);
    await expect(verifyBackups(stack)).rejects.toThrow(/does not decrypt/);
  });

  it('verify fails when the passphrase in backup.env is not the one the archive was made with', async () => {
    makeContainers();
    const nas = makeFolderTarget();
    const stack = makeStack('stack', { BACKUP_TARGETS: nas });
    await runBackup(stack);
    writeBackupEnv(stack, { BACKUP_TARGETS: nas, BACKUP_PASSPHRASE: 'a-different-passphrase-entirely' });
    await expect(verifyBackups(stack)).rejects.toThrow(/wrong BACKUP_PASSPHRASE/);
  });

  it('check reports every target and fails on one that is not writable', async () => {
    const nas = makeFolderTarget();
    const stack = makeStack('stack', { BACKUP_TARGETS: `${nas} ${join(tmp, 'unmounted-nas')}` });
    await expect(checkConfig(stack)).rejects.toThrow(/unmounted-nas does not exist\. Is the NAS mounted\?/);
    writeBackupEnv(stack, { BACKUP_TARGETS: nas });
    await expect(checkConfig(stack)).resolves.toBeUndefined();
  });
});

// ── targets ─────────────────────────────────────────────────────────────────

describe('folder target', () => {
  it('refuses a folder on the stack’s own disk unless BACKUP_ALLOW_SAME_DISK=yes', async () => {
    const nas = makeFolderTarget();
    const t = openTarget(nas, { env: {}, stackDir: tmp });
    await expect(t.check()).rejects.toThrow(/same disk as the stack/);
    await expect(openTarget(nas, { env: { BACKUP_ALLOW_SAME_DISK: 'yes' }, stackDir: tmp }).check()).resolves.toBeUndefined();
  });

  it('never creates a missing folder — that is how an unmounted NAS turns into a local backup', async () => {
    const t = openTarget(join(tmp, 'mnt', 'nas'), { env: { BACKUP_ALLOW_SAME_DISK: 'yes' }, stackDir: tmp });
    const file = join(tmp, 'f');
    writeFileSync(file, 'x');
    await expect(t.put(file, 'a.bak')).rejects.toThrow(/Is the NAS mounted/);
    expect(existsSync(join(tmp, 'mnt'))).toBe(false);
  });

  it('rejects a target it cannot classify', () => {
    expect(() => openTarget('nas.local:/backups', { env: {}, stackDir: tmp })).toThrow(/cannot tell what kind of target/);
  });
});

describe('sftp target', () => {
  it('uploads under a temporary name and renames, lists, fetches and removes — in batch mode only', async () => {
    const remote = join(tmp, 'remote');
    mkdirSync(join(remote, 'backups', 'my 0815'), { recursive: true });
    process.env.FAKE_SFTP_ROOT = remote;
    const t = openTarget('sftp://backup@nas.local:2222/backups/my%200815', { env: {}, stackDir: tmp });
    expect(t.label).toBe('sftp://backup@nas.local:2222/backups/my 0815');
    await t.check();

    const file = join(tmp, 'archive');
    writeFileSync(file, 'payload');
    await t.put(file, '0815-x-20261107T020000Z.bak');
    expect(readdirSync(join(remote, 'backups', 'my 0815'))).toEqual(['0815-x-20261107T020000Z.bak']);
    expect(await t.list()).toEqual(['0815-x-20261107T020000Z.bak']);
    await t.get('0815-x-20261107T020000Z.bak', join(tmp, 'back'));
    expect(readFileSync(join(tmp, 'back'), 'utf8')).toBe('payload');
    await t.remove('0815-x-20261107T020000Z.bak');
    expect(await t.list()).toEqual([]);

    const calls = readFileSync(join(tmp, 'sftp-calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const args of calls) {
      expect(args).toContain('BatchMode=yes');
      expect(args.slice(-1)[0]).toBe('backup@nas.local');
      expect(args).toEqual(expect.arrayContaining(['-P', '2222']));
    }
  });

  it('insists on an account name', () => {
    expect(() => openTarget('sftp://nas.local/backups', { env: {}, stackDir: tmp })).toThrow(/name the account/);
  });
});

describe('S3 signing — AWS Signature Version 4, against AWS’s published examples', () => {
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('sig-v4 test suite: get-vanilla', () => {
    const { signature } = signV4({
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: EMPTY,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      amzDate: '20150830T123600Z',
    });
    expect(signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  const s3Example = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    amzDate: '20130524T000000Z',
    payloadHash: EMPTY,
  };

  it('S3 API reference example: GET object with a Range header', () => {
    const { signature } = signV4({
      ...s3Example,
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY,
        'x-amz-date': '20130524T000000Z',
      },
    });
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('S3 API reference example: list objects with a query string', () => {
    const { signature } = signV4({
      ...s3Example,
      method: 'GET',
      path: '/',
      query: { 'max-keys': '2', prefix: 'J' },
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' },
    });
    expect(signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('needs credentials before it talks to anything', () => {
    expect(() => openTarget('s3://bucket/x', { env: {}, stackDir: tmp })).toThrow(/BACKUP_S3_ACCESS_KEY_ID/);
  });
});

// ── encryption ──────────────────────────────────────────────────────────────

describe('archive encryption', () => {
  const plain = () => {
    const p = join(tmp, 'plain');
    writeFileSync(p, randomBytes(200_000));
    return p;
  };

  it('round-trips', async () => {
    const p = plain();
    await encryptFile(p, join(tmp, 'enc'), PASSPHRASE);
    await decryptFile(join(tmp, 'enc'), join(tmp, 'dec'), PASSPHRASE);
    expect(readFileSync(join(tmp, 'dec')).equals(readFileSync(p))).toBe(true);
    expect(statSync(join(tmp, 'enc')).mode & 0o077).toBe(0);
  });

  it('two archives of the same data share no bytes beyond the format marker (fresh salt and IV)', async () => {
    const p = plain();
    await encryptFile(p, join(tmp, 'a'), PASSPHRASE);
    await encryptFile(p, join(tmp, 'b'), PASSPHRASE);
    expect(readFileSync(join(tmp, 'a')).subarray(11, 39).equals(readFileSync(join(tmp, 'b')).subarray(11, 39))).toBe(false);
  });

  for (const [what, damage] of [
    ['a wrong passphrase', null],
    ['one flipped bit in the ciphertext', (b: Buffer) => (b[Math.floor(b.length / 2)] ^= 0x01)],
    ['a changed KDF parameter in the header', (b: Buffer) => (b[9] = 9)],
    ['a truncated file', 'truncate'],
  ] as const) {
    it(`fails closed on ${what}, and writes no output`, async () => {
      const p = plain();
      const enc = join(tmp, 'enc');
      await encryptFile(p, enc, PASSPHRASE);
      let bytes = readFileSync(enc);
      if (damage === 'truncate') bytes = bytes.subarray(0, bytes.length - 1000);
      else if (damage) damage(bytes);
      writeFileSync(enc, bytes);
      await expect(decryptFile(enc, join(tmp, 'dec'), damage ? PASSPHRASE : 'not-the-passphrase-at-all')).rejects.toThrow();
      expect(existsSync(join(tmp, 'dec'))).toBe(false);
      expect(existsSync(join(tmp, 'dec.partial'))).toBe(false);
    });
  }

  it('refuses a file that is not an archive', async () => {
    writeFileSync(join(tmp, 'x'), 'SQLite format 3\0 — plainly not encrypted at all, and long enough');
    await expect(decryptFile(join(tmp, 'x'), join(tmp, 'y'), PASSPHRASE)).rejects.toThrow(/not a 0815 backup archive/);
  });
});

// ── retention ───────────────────────────────────────────────────────────────

describe('retention', () => {
  const day = (iso: string) => ({ name: iso, date: new Date(`${iso}T02:00:00Z`) });

  it('uses ISO weeks — the Thursday decides the year', () => {
    expect(retentionKeys.weekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01'); // a Thursday
    expect(retentionKeys.weekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // a Friday
    expect(retentionKeys.weekKey(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01'); // a Monday
  });

  it('keeps the newest per day, week and month, counting back over archives that exist', () => {
    const archives = [];
    for (let d = 0; d < 120; d++) {
      const date = new Date(Date.UTC(2026, 6, 10 + d, 2));
      archives.push({ name: date.toISOString().slice(0, 10), date });
    }
    const { keep, remove } = selectRetained(archives, { daily: 3, weekly: 2, monthly: 3 });
    // 2026-11-06 is the newest: three days, the Sunday ending the previous
    // week, and the last day of the two months before.
    expect(keep).toEqual(['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-01', '2026-10-31', '2026-09-30']);
    expect(keep.length + remove.length).toBe(120);
  });

  it('a host that was off for weeks keeps its last dailies — buckets count archives, not calendar days', () => {
    const { keep } = selectRetained([day('2026-11-07'), day('2026-10-01'), day('2026-09-30'), day('2026-09-29')], {
      daily: 3,
      weekly: 0,
      monthly: 0,
    });
    expect(keep).toEqual(['2026-11-07', '2026-10-01', '2026-09-30']);
  });

  it('never removes the newest archive, whatever the policy', () => {
    expect(selectRetained([day('2026-11-07'), day('2026-11-06')], { daily: 0, weekly: 0, monthly: 0 }).keep).toEqual(['2026-11-07']);
  });

  it('several archives on one day: only the newest of that day counts for the day', () => {
    const archives = [
      { name: 'late', date: new Date('2026-11-07T22:00:00Z') },
      { name: 'early', date: new Date('2026-11-07T02:00:00Z') },
      { name: 'yesterday', date: new Date('2026-11-06T02:00:00Z') },
    ];
    expect(selectRetained(archives, { daily: 2, weekly: 0, monthly: 0 })).toEqual({ keep: ['late', 'yesterday'], remove: ['early'] });
  });
});

// ── configuration ───────────────────────────────────────────────────────────

describe('backup.env', () => {
  const stackWith = (text: string) => {
    const dir = mkdtempSync(join(tmp, 'cfg-'));
    writeFileSync(join(dir, 'backup.env'), text);
    return dir;
  };

  it('the rendered template parses back to its defaults and documents every key', () => {
    const parsed = parseEnvFile(renderConfig());
    expect(parsed.BACKUP_KEEP_DAILY).toBe('7');
    expect(parsed.BACKUP_KEEP_MONTHLY).toBe('12');
    const cfg = loadConfig(stackWith(renderConfig()), {});
    expect(cfg.targets).toEqual([]);
    expect(cfg.retention).toEqual({ daily: 7, weekly: 4, monthly: 12 });
  });

  it('several targets, separated by spaces', () => {
    const cfg = loadConfig(stackWith(`BACKUP_TARGETS="/mnt/nas  s3://b/p"\nBACKUP_PASSPHRASE=${PASSPHRASE}\n`), {});
    expect(cfg.targets).toEqual(['/mnt/nas', 's3://b/p']);
  });

  it.each([
    ['BACKUP_TAGRETS=/mnt/nas', /unknown setting BACKUP_TAGRETS/],
    ['BACKUP_TARGETS=/mnt/nas', /BACKUP_PASSPHRASE is not set/],
    ['BACKUP_TARGETS=/mnt/nas\nBACKUP_PASSPHRASE=FILL-ME-IN', /BACKUP_PASSPHRASE is not set/],
    ['BACKUP_TARGETS=/mnt/nas\nBACKUP_PASSPHRASE=short', /at least 16/],
    ['BACKUP_TARGETS=FILL-ME-IN\nBACKUP_PASSPHRASE=long-enough-passphrase', /still says FILL-ME-IN/],
    ['BACKUP_KEEP_DAILY=seven', /whole number/],
    ['BACKUP_KEEP_DAILY=0', /at least 1/],
    ['BACKUP_ALERT_URL=mailto:it@example.com', /http\(s\) URL/],
    ['this is not a setting', /expected KEY=value/],
  ])('refuses %j', (text, error) => {
    expect(() => loadConfig(stackWith(text), {})).toThrow(error);
  });

  it('reads the passphrase from BACKUP_PASSPHRASE_FILE, and the environment overrides the file', () => {
    writeFileSync(join(tmp, 'pass'), `${PASSPHRASE}\n`);
    const dir = stackWith(`BACKUP_TARGETS=/mnt/nas\nBACKUP_PASSPHRASE_FILE=${join(tmp, 'pass')}\n`);
    expect(loadConfig(dir, {}).passphrase).toBe(PASSPHRASE);
    expect(loadConfig(dir, { BACKUP_TARGETS: '/mnt/other' }).targets).toEqual(['/mnt/other']);
  });

  it('names the stack after the provisioned customer', () => {
    const dir = mkdtempSync(join(tmp, 'Some Folder-'));
    expect(stackNameOf(dir)).toMatch(/^some-folder-/);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ customer: 'Blaustern GmbH' }));
    expect(stackNameOf(dir)).toBe('blaustern-gmbh');
  });
});
