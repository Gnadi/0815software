#!/usr/bin/env node
/**
 * Backups for ONE stack — snapshot, encrypt, send off the host, keep, verify,
 * restore. Run on the host, next to Docker; Node built-ins and the host's
 * `tar` (plus `sftp` for sftp:// targets), nothing else.
 *
 *   node deploy/backup.mjs setup   [stack-dir]   # where should backups go? writes backup.env
 *   node deploy/backup.mjs check   [stack-dir]   # config valid, every target writable?
 *   node deploy/backup.mjs run     [stack-dir]   # the nightly job (backup.sh calls this)
 *   node deploy/backup.mjs list    [stack-dir]   # archives on each target
 *   node deploy/backup.mjs verify  [stack-dir]   # fetch + decrypt the newest — a restore drill
 *   node deploy/backup.mjs restore [stack-dir] [--archive NAME] [--from TARGET] [--apply --yes]
 *
 * What `run` does, and why in this order:
 *
 *  1. Every running container that ships scripts/backup.mjs snapshots its own
 *     database (online-consistent, better-sqlite3's backup API) and its files
 *     into a fresh run-<stamp> folder on its own volume. The containers are
 *     asked, never listed here — a hardcoded list is how PS-11 and every module
 *     once went unbacked-up.
 *  2. Older run folders beyond BACKUP_KEEP_LOCAL are pruned, so the volume
 *     does not fill up with snapshots nobody deletes.
 *  3. The snapshots, plus the stack's own files (.env, compose file, Caddyfile,
 *     manifest), become ONE archive: a restore on a new host needs the secrets
 *     as much as the data — a database is useless with the wrong
 *     SESSION_SECRET, and PS-12's bank keys with the wrong EBICS_KEY_SECRET.
 *     backup.env is NOT included: it holds the passphrase that opens the
 *     archive and the target's credentials.
 *  4. The archive is encrypted (lib/backup-crypto.mjs) and copied to every
 *     target in BACKUP_TARGETS; each target then applies retention.
 *  5. backup-status.json records the outcome. A failure POSTs to
 *     BACKUP_ALERT_URL; a success pings BACKUP_HEARTBEAT_URL, whose silence is
 *     what tells you about the backup that never ran at all.
 *
 * Exit code 0 only when every container was snapshotted AND every target holds
 * the archive. Anything less is a failure, loudly — a backup that is "mostly
 * fine" is the one you find out about on the day you need it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { decryptFile, encryptFile } from './lib/backup-crypto.mjs';
import { CONFIG_FILE, ConfigError, KEYS, loadConfig, parseEnvFile, renderConfig } from './lib/backup-config.mjs';
import { selectRetained } from './lib/backup-retention.mjs';
import { openTarget, TargetError } from './lib/backup-targets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARCHIVE_FORMAT = 1;

/**
 * The stack's own files that go into an archive — what provision.mjs writes,
 * plus compose override files an operator may have added. A list, not
 * "everything in the folder": the reference stack's folder is deploy/ itself,
 * with node_modules beside it, and backup.env must never be in an archive.
 */
const STACK_FILE = /^(\.env|(docker-)?compose(\.[\w-]+)?\.ya?ml|Caddyfile|README\.md|manifest\.json|monitoring)$/;

class BackupError extends Error {}

// ── small helpers ────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[backup] ${msg}`);
}

function warn(msg) {
  console.error(`[backup] ${msg}`);
}

/** Run a command; resolve stdout, reject with stderr. `inherit` streams output through. */
function sh(cmd, args, { cwd, inherit = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', inherit ? 'inherit' : 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => {
      stderr += c;
      if (inherit) process.stderr.write(c);
    });
    child.on('error', (err) =>
      reject(new BackupError(err.code === 'ENOENT' ? `\`${cmd}\` is not installed on this host` : err.message)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(new BackupError(`${cmd} ${args.slice(0, 3).join(' ')} … failed: ${stderr.trim() || `exit ${code}`}`)),
    );
  });
}

const compose = (stackDir, args, opts) => sh('docker', ['compose', ...args], { cwd: stackDir, ...opts });

/** "20261107T020000Z" — sortable, filename-safe, UTC. */
export function stampOf(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateOfStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

/** The stack's name as it appears in archive names: the provisioned customer, else the folder. */
export function stackNameOf(stackDir) {
  let name = basename(resolve(stackDir));
  const manifest = join(stackDir, 'manifest.json');
  if (existsSync(manifest)) {
    try {
      name = JSON.parse(readFileSync(manifest, 'utf8')).customer || name;
    } catch {
      // A broken manifest is the provisioner's problem; the folder name will do.
    }
  }
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'stack';
}

/** Archive names this stack owns. Nothing else on a target is ever touched. */
export function archiveName(stack, date) {
  return `0815-${stack}-${stampOf(date)}.bak`;
}

export function parseArchiveName(stack, name) {
  const m = new RegExp(`^0815-${stack.replace(/[-]/g, '\\-')}-(\\d{8}T\\d{6}Z)\\.bak$`).exec(name);
  if (!m) return null;
  const date = dateOfStamp(m[1]);
  return date ? { name, date } : null;
}

async function listArchives(target, stack) {
  return (await target.list())
    .map((n) => parseArchiveName(stack, n))
    .filter(Boolean)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function openTargets(config, stackDir) {
  return config.targets.map((spec) => ({ spec, target: openTarget(spec, { env: config.env, stackDir }) }));
}

function workDirOf(config, stackDir) {
  const dir = config.env.BACKUP_WORK_DIR || join(stackDir, '.backup-work');
  return isAbsolute(dir) ? dir : resolve(stackDir, dir);
}

// ── code run inside the containers ───────────────────────────────────────────
// Passed to `node -e`, so it may only use what a service image has: Node.

/** Does this container back itself up, and where do its snapshots go? */
const PROBE = `const fs=require('fs');process.stdout.write(JSON.stringify({script:fs.existsSync('scripts/backup.mjs'),dir:process.env.BACKUP_DIR||'./backups'}))`;

/** Keep the newest N run-* folders in BACKUP_DIR, delete the rest. argv[1] = N. */
const PRUNE = `const fs=require('fs'),p=require('path');const d=process.env.BACKUP_DIR||'./backups';const keep=Number(process.argv[1]);if(!(keep>=1))process.exit(2);const runs=fs.existsSync(d)?fs.readdirSync(d).filter(n=>/^run-/.test(n)).sort().reverse():[];for(const n of runs.slice(keep))fs.rmSync(p.join(d,n),{recursive:true,force:true});`;

/**
 * Put one service's snapshot back, from RESTORE_FROM into the places the
 * container's own env names. The database is written beside its target and
 * renamed over it, and the old -wal/-shm files are removed first: a stale WAL
 * left next to a restored database would be replayed into it on open. A
 * files folder "<prefix>-<stamp>" goes back to <PREFIX>_DIR — the naming every
 * module's backup.mjs uses (deploy/test/backup.test.ts pins it).
 */
const RESTORE = `const fs=require('fs'),p=require('path');const src=process.env.RESTORE_FROM;const names=fs.readdirSync(src);
const db=names.filter(n=>/^backup-.*\\.db$/.test(n)).sort().pop();if(!db){console.error('no database snapshot in '+src);process.exit(3);}
const target=process.env.DATABASE_PATH||'./data.db';fs.mkdirSync(p.dirname(target),{recursive:true});
for(const s of ['-wal','-shm','-journal'])fs.rmSync(target+s,{force:true});
fs.copyFileSync(p.join(src,db),target+'.restoring');fs.renameSync(target+'.restoring',target);console.log('restored '+target);
for(const n of names){const m=/^([a-z]+)-\\d/.exec(n);if(!m||n.startsWith('backup-')||!fs.statSync(p.join(src,n)).isDirectory())continue;
const env=m[1].toUpperCase()+'_DIR';const dest=process.env[env];if(!dest){console.error(n+' needs '+env+', which this container does not set');process.exit(4);}
fs.rmSync(dest,{recursive:true,force:true});fs.cpSync(p.join(src,n),dest,{recursive:true});console.log('restored '+dest);}`;

// ── run ──────────────────────────────────────────────────────────────────────

/** Step 1+2: snapshot every container that can, copy the snapshots out, prune old ones. */
async function snapshotContainers(stackDir, servicesDir, stamp, keepLocal) {
  const running = (await compose(stackDir, ['ps', '--services', '--status', 'running']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const done = [];
  const failed = [];
  for (const svc of running) {
    let probe;
    try {
      probe = JSON.parse(await compose(stackDir, ['exec', '-T', svc, 'node', '-e', PROBE]));
    } catch {
      continue; // no Node in it (Caddy, Prometheus …): holds no business data
    }
    if (!probe.script) continue;
    const runDir = `${probe.dir.replace(/\/+$/, '')}/run-${stamp}`;
    try {
      log(`snapshot ${svc}`);
      await compose(stackDir, ['exec', '-T', '-e', `BACKUP_DIR=${runDir}`, svc, 'npm', 'run', '--silent', 'backup']);
      await compose(stackDir, ['cp', `${svc}:${runDir}`, join(servicesDir, svc)]);
      done.push(svc);
    } catch (err) {
      warn(`FAILED: ${svc} — ${err.message}`);
      failed.push(svc);
      continue;
    }
    try {
      await compose(stackDir, ['exec', '-T', svc, 'node', '-e', PRUNE, String(keepLocal)]);
    } catch (err) {
      // Not fatal for tonight's backup, but the volume will fill up: say so.
      warn(`could not prune old snapshots in ${svc}: ${err.message}`);
    }
  }
  return { running, done, failed };
}

/** Step 3: the stack's own files — what a fresh host needs besides the data. */
function copyStackFiles(stackDir, dest) {
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const name of readdirSync(stackDir)) {
    if (!STACK_FILE.test(name)) continue;
    cpSync(join(stackDir, name), join(dest, name), { recursive: true });
    copied.push(name);
  }
  return copied;
}

function writeStatus(stackDir, status) {
  writeFileSync(join(stackDir, 'backup-status.json'), `${JSON.stringify(status, null, 2)}\n`);
}

/**
 * @typedef {{ label: string, uploaded: boolean, kept: string[], removed: string[] }} TargetResult
 * @typedef {{ stack: string, startedAt: string, finishedAt: string, host: string, ok: boolean,
 *             errors: string[], archive: { name: string, bytes: number } | null,
 *             services: { backedUp: string[], failed: string[] },
 *             targets: Record<string, TargetResult> }} BackupStatus
 */

/** @returns {Promise<BackupStatus>} */
export async function runBackup(stackDir, { localOnly = false, now = new Date() } = {}) {
  const config = loadConfig(stackDir);
  const stack = stackNameOf(stackDir);
  const stamp = stampOf(now);
  const errors = [];

  if (config.targets.length === 0 && !localOnly) {
    errors.push(
      `no BACKUP_TARGETS in ${config.file} — snapshots stay on this host's disk and will not survive it. ` +
        `Run: node ${join(HERE, 'backup.mjs')} setup ${stackDir}`,
    );
  }
  const targets = localOnly ? [] : openTargets(config, stackDir);

  const workDir = workDirOf(config, stackDir);
  rmSync(workDir, { recursive: true, force: true });
  const bundle = join(workDir, 'bundle');
  mkdirSync(join(bundle, 'services'), { recursive: true });
  chmodSync(workDir, 0o700);

  /** @type {BackupStatus} */
  const status = {
    stack,
    startedAt: now.toISOString(),
    finishedAt: '',
    host: hostname(),
    ok: false,
    errors,
    archive: null,
    services: { backedUp: [], failed: [] },
    targets: {},
  };
  try {
    const snap = await snapshotContainers(stackDir, join(bundle, 'services'), stamp, config.keepLocal);
    status.services = { backedUp: snap.done, failed: snap.failed };
    if (snap.done.length === 0) {
      throw new BackupError('nothing was backed up — is the stack running? (docker compose ps)');
    }
    for (const svc of snap.failed) errors.push(`snapshot of ${svc} failed`);

    if (targets.length > 0) {
      const stackFiles = copyStackFiles(stackDir, join(bundle, 'stack'));
      writeFileSync(
        join(bundle, 'manifest.json'),
        `${JSON.stringify(
          { format: ARCHIVE_FORMAT, stack, createdAt: now.toISOString(), host: hostname(), services: snap.done, failed: snap.failed, stackFiles },
          null,
          2,
        )}\n`,
      );
      const tarball = join(workDir, 'archive.tar.gz');
      await sh('tar', ['-czf', tarball, '-C', bundle, '.']);
      rmSync(bundle, { recursive: true, force: true });

      const name = archiveName(stack, now);
      const archive = join(workDir, name);
      await encryptFile(tarball, archive, config.passphrase);
      rmSync(tarball);
      status.archive = { name, bytes: statSync(archive).size };
      log(`archive ${name} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MiB, encrypted)`);

      for (const { spec, target } of targets) {
        const result = { label: target.label, uploaded: false, kept: [], removed: [] };
        status.targets[spec] = result;
        try {
          await target.put(archive, name);
          result.uploaded = true;
          log(`→ ${target.label}`);
        } catch (err) {
          errors.push(`upload to ${target.label} failed: ${err.message}`);
          warn(`FAILED → ${target.label}: ${err.message}`);
          continue;
        }
        try {
          const { keep, remove } = selectRetained(await listArchives(target, stack), config.retention);
          for (const old of remove) {
            await target.remove(old);
            result.removed.push(old);
          }
          result.kept = keep;
          if (remove.length > 0) log(`  ${target.label}: removed ${remove.length} old archive(s), ${keep.length} kept`);
        } catch (err) {
          // The archive is there; only retention failed. Still a failure — the target will fill up.
          errors.push(`retention on ${target.label} failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  status.finishedAt = new Date().toISOString();
  status.ok = errors.length === 0;
  writeStatus(stackDir, status);

  if (status.ok) {
    log(`done ${status.finishedAt}: ${status.services.backedUp.join(' ')}`);
    if (config.heartbeatUrl) {
      await fetch(config.heartbeatUrl, { signal: AbortSignal.timeout(15_000) }).catch((err) =>
        warn(`heartbeat ping failed: ${err.message}`),
      );
    }
  } else {
    for (const e of errors) warn(`ERROR: ${e}`);
    if (config.alertUrl) {
      const text = `0815 backup FAILED for "${stack}" on ${hostname()}: ${errors.join('; ')}`;
      await postJson(config.alertUrl, { text, message: text, stack, host: hostname(), status: 'failed', errors, at: status.finishedAt }).catch(
        (err) => warn(`alert could not be sent to BACKUP_ALERT_URL: ${err.message}`),
      );
    }
  }
  return status;
}

// ── check / list / verify ────────────────────────────────────────────────────

export async function checkConfig(stackDir, { testAlert = false } = {}) {
  const config = loadConfig(stackDir);
  const problems = [];
  console.log(`Backup configuration of ${resolve(stackDir)}`);
  console.log(`  file        ${config.file}${config.fileExists ? '' : '  (missing — run `setup`)'}`);
  console.log(`  retention   ${config.retention.daily} daily, ${config.retention.weekly} weekly, ${config.retention.monthly} monthly; ${config.keepLocal} on each volume`);
  console.log(`  alert       ${config.alertUrl ?? '(none — failures only show in the log)'}`);
  console.log(`  heartbeat   ${config.heartbeatUrl ?? '(none — a backup that never runs goes unnoticed)'}`);
  if (config.targets.length === 0) problems.push('no BACKUP_TARGETS: nothing leaves this host');
  if (config.targets.length === 1) console.log('  note        one target; a second one in another building is what survives a fire or a burglary');

  for (const spec of config.targets) {
    try {
      const target = openTarget(spec, { env: config.env, stackDir });
      await target.check();
      const count = (await listArchives(target, stackNameOf(stackDir))).length;
      console.log(`  ✓ ${target.label} — writable, ${count} archive(s) of this stack`);
    } catch (err) {
      console.log(`  ✗ ${spec} — ${err.message}`);
      problems.push(`${spec}: ${err.message}`);
    }
  }
  if (testAlert) {
    if (!config.alertUrl) problems.push('--test-alert given but BACKUP_ALERT_URL is empty');
    else {
      const text = `0815 backup: test alert from ${hostname()} — if you read this, failures will reach you.`;
      await postJson(config.alertUrl, { text, message: text, status: 'test' })
        .then(() => console.log('  ✓ test alert sent'))
        .catch((err) => problems.push(`test alert failed: ${err.message}`));
    }
  }
  if (problems.length > 0) {
    throw new BackupError(`configuration is not ready:\n  - ${problems.join('\n  - ')}`);
  }
  console.log('Ready.');
}

async function listAll(stackDir) {
  const config = loadConfig(stackDir);
  const stack = stackNameOf(stackDir);
  for (const { target } of openTargets(config, stackDir)) {
    const archives = await listArchives(target, stack);
    console.log(`${target.label}: ${archives.length} archive(s)`);
    for (const a of archives) console.log(`  ${a.name}   ${a.date.toISOString()}`);
  }
}

/** Fetch an archive, decrypt it and unpack it into `dest`. Returns its manifest. */
async function fetchArchive(config, target, name, workDir, dest) {
  mkdirSync(workDir, { recursive: true });
  chmodSync(workDir, 0o700);
  const enc = join(workDir, name);
  const tarball = join(workDir, 'archive.tar.gz');
  await target.get(name, enc);
  await decryptFile(enc, tarball, config.passphrase);
  rmSync(enc);
  mkdirSync(dest, { recursive: true });
  await sh('tar', ['-xzf', tarball, '-C', dest]);
  rmSync(tarball);
  const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'));
  if (manifest.format !== ARCHIVE_FORMAT) throw new BackupError(`archive format ${manifest.format} is not one this tool reads`);
  return manifest;
}

/**
 * The restore drill: the newest archive on every target is fetched,
 * decrypted and unpacked, and every database in it is checked to really be a
 * SQLite file. Proves the passphrase, the target and the archive all work —
 * worth a cron line of its own (weekly), because an untested backup is a hope.
 */
export async function verifyBackups(stackDir) {
  const config = loadConfig(stackDir);
  const stack = stackNameOf(stackDir);
  const workDir = workDirOf(config, stackDir);
  const problems = [];
  for (const { target } of openTargets(config, stackDir)) {
    const [newest] = await listArchives(target, stack).catch((err) => {
      problems.push(`${target.label}: ${err.message}`);
      return [];
    });
    if (!newest) {
      problems.push(`${target.label}: no archive of "${stack}"`);
      continue;
    }
    const dest = join(workDir, 'verify');
    rmSync(workDir, { recursive: true, force: true });
    try {
      const manifest = await fetchArchive(config, target, newest.name, workDir, dest);
      const ageHours = (Date.now() - newest.date.getTime()) / 3_600_000;
      let dbs = 0;
      for (const svc of manifest.services) {
        const dir = join(dest, 'services', svc);
        const db = readdirSync(dir).find((n) => /^backup-.*\.db$/.test(n));
        if (!db) throw new BackupError(`${svc} has no database snapshot`);
        const head = readFileSync(join(dir, db)).subarray(0, 16).toString('latin1');
        if (head !== 'SQLite format 3\0') throw new BackupError(`${svc}/${db} is not a SQLite database`);
        dbs++;
      }
      if (!existsSync(join(dest, 'stack', '.env'))) problems.push(`${target.label}: ${newest.name} carries no .env`);
      console.log(`  ✓ ${target.label}: ${newest.name} — decrypts, ${dbs} database(s), ${ageHours.toFixed(1)} h old`);
      if (ageHours > 36) problems.push(`${target.label}: newest archive is ${ageHours.toFixed(0)} h old — is the nightly job running?`);
    } catch (err) {
      problems.push(`${target.label}: ${newest.name}: ${err.message}`);
      console.log(`  ✗ ${target.label}: ${err.message}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  if (problems.length > 0) throw new BackupError(`verification failed:\n  - ${problems.join('\n  - ')}`);
}

// ── restore ──────────────────────────────────────────────────────────────────

/**
 * Bring an archive back. Without --apply it only unpacks into
 * <stack>/restore-<stamp>/ and, on an empty stack folder (the new-host case),
 * puts the stack's files (.env, compose file …) in place — nothing running is
 * touched. With --apply --yes it also stops the stack, writes every service's
 * snapshot into its volume and starts the stack again.
 */
export async function restore(stackDir, { archive, from, apply = false, yes = false } = {}) {
  if (apply && !yes) {
    throw new BackupError('--apply overwrites the live databases of this stack with the archive; add --yes to confirm');
  }
  const config = loadConfig(stackDir);
  const stack = stackNameOf(stackDir);
  const all = openTargets(config, stackDir);
  if (all.length === 0) throw new BackupError(`no BACKUP_TARGETS in ${config.file} to restore from`);
  const chosen = from ? all.find((t) => t.spec === from || t.target.label === from) : all[0];
  if (!chosen) throw new BackupError(`${from} is not one of BACKUP_TARGETS (${all.map((t) => t.spec).join(', ')})`);

  const archives = await listArchives(chosen.target, stack);
  const pick = !archive || archive === 'latest' ? archives[0] : archives.find((a) => a.name === archive);
  if (!pick) {
    throw new BackupError(
      archive ? `${archive} is not on ${chosen.target.label}` : `no archive of "${stack}" on ${chosen.target.label}`,
    );
  }
  const dest = join(stackDir, `restore-${stampOf(pick.date)}`);
  rmSync(dest, { recursive: true, force: true });
  const workDir = workDirOf(config, stackDir);
  log(`fetching ${pick.name} from ${chosen.target.label}`);
  let manifest;
  try {
    manifest = await fetchArchive(config, chosen.target, pick.name, workDir, dest);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  log(`unpacked into ${dest} (${manifest.services.length} service(s))`);

  // New host: the stack folder holds only backup.env. Put the stack back.
  const placed = [];
  for (const name of readdirSync(join(dest, 'stack'))) {
    if (existsSync(join(stackDir, name))) continue;
    cpSync(join(dest, 'stack', name), join(stackDir, name), { recursive: true });
    placed.push(name);
  }
  if (placed.length > 0) log(`put back ${placed.join(', ')}`);
  if (existsSync(join(stackDir, '.env'))) chmodSync(join(stackDir, '.env'), 0o600);
  const kept = readdirSync(join(dest, 'stack')).filter((n) => !placed.includes(n));
  if (kept.length > 0) log(`kept the existing ${kept.join(', ')} — the archived copies are in ${join(dest, 'stack')}`);

  if (!apply) {
    log(`nothing running was changed. To write the data into the stack: … restore ${stackDir} --archive ${pick.name} --apply --yes`);
    return { dest, manifest, applied: false };
  }

  log('stopping the stack');
  // `create` makes containers and volumes exist on a fresh host without starting anything.
  await compose(stackDir, ['stop'], { inherit: true });
  await compose(stackDir, ['create'], { inherit: true });
  for (const svc of manifest.services) {
    log(`restoring ${svc}`);
    await compose(stackDir, [
      'run', '--rm', '--no-deps', '-T',
      '-v', `${join(resolve(dest), 'services', svc)}:/restore:ro`,
      '-e', 'RESTORE_FROM=/restore',
      '--entrypoint', 'node',
      svc, '-e', RESTORE,
    ], { inherit: true });
  }
  log('starting the stack — pending migrations apply on boot');
  await compose(stackDir, ['up', '-d'], { inherit: true });
  log(`restored ${pick.name}. Check the services' /api/health, then delete ${dest}.`);
  return { dest, manifest, applied: true };
}

// ── setup ────────────────────────────────────────────────────────────────────

/**
 * Ask where backups should go and write backup.env. Existing values are the
 * defaults, so running it again to add a second target changes nothing else.
 */
async function setup(stackDir) {
  const file = join(stackDir, CONFIG_FILE);
  const current = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const values = { ...KEYS, ...current };
  // A line queue rather than rl.question(): with answers piped in (a script,
  // a here-doc) readline emits every line at once, and question() would miss
  // the ones that arrived before it asked — then hang, or exit silently.
  const rl = createInterface({ input: process.stdin });
  /** @type {string[]} */
  const lines = [];
  /** @type {((line: string | null) => void)[]} */
  const waiting = [];
  let closed = false;
  rl.on('line', (line) => (waiting.length > 0 ? waiting.shift()?.(line) : lines.push(line)));
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  /** @returns {Promise<string>} */
  const ask = async (q, def = '') => {
    process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
    const line =
      lines.length > 0 ? lines.shift() : closed ? null : await new Promise((r) => waiting.push(r));
    if (line === null || line === undefined) throw new BackupError('setup: input ended before every question was answered');
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    return line.trim() || def;
  };

  try {
    console.log(`\nBackup setup for ${resolve(stackDir)}\n`);
    const targets = values.BACKUP_TARGETS.split(/\s+/).filter((t) => t && t !== 'FILL-ME-IN');
    if (targets.length > 0) {
      console.log(`Current targets:\n${targets.map((t) => `  - ${t}`).join('\n')}`);
      if ((await ask('Keep them? (y/n)', 'y')).toLowerCase().startsWith('n')) targets.length = 0;
    }
    for (;;) {
      if (targets.length > 0 && !(await ask('Add another target? (y/n)', 'n')).toLowerCase().startsWith('y')) break;
      console.log(`
Where should backups go?
  1) a NAS share mounted on this host (SMB/NFS), or a USB disk
  2) a NAS or server over SSH/SFTP
  3) S3-compatible storage (Hetzner, Wasabi, IONOS, AWS, MinIO on the NAS …)`);
      const kind = await ask('Choice', '1');
      if (kind === '1') {
        console.log('  Mount the share first (e.g. /etc/fstab: //nas.local/backup /mnt/nas cifs credentials=…,_netdev 0 0).');
        targets.push(await ask('  Folder on the mounted share', '/mnt/nas/0815-backups'));
      } else if (kind === '2') {
        const host = await ask('  NAS host name or IP', 'nas.local');
        const user = await ask('  Account', 'backup');
        const port = await ask('  SSH port', '22');
        const path = await ask('  Folder on the NAS', '/backups/0815');
        values.BACKUP_SFTP_IDENTITY = await ask('  Private key file (empty = ~/.ssh default)', values.BACKUP_SFTP_IDENTITY);
        targets.push(`sftp://${encodeURIComponent(user)}@${host}${port === '22' ? '' : `:${port}`}/${path.replace(/^\/+/, '')}`);
      } else if (kind === '3') {
        const bucket = await ask('  Bucket');
        const prefix = await ask('  Folder in the bucket', stackNameOf(stackDir));
        values.BACKUP_S3_ENDPOINT = await ask('  Endpoint URL (empty = AWS)', values.BACKUP_S3_ENDPOINT);
        values.BACKUP_S3_REGION = await ask('  Region', values.BACKUP_S3_REGION || 'eu-central-1');
        values.BACKUP_S3_ACCESS_KEY_ID = await ask('  Access key id', values.BACKUP_S3_ACCESS_KEY_ID);
        values.BACKUP_S3_SECRET_ACCESS_KEY = await ask('  Secret access key', values.BACKUP_S3_SECRET_ACCESS_KEY);
        targets.push(`s3://${bucket}/${prefix}`.replace(/\/+$/, ''));
      } else {
        console.log('  Please answer 1, 2 or 3.');
      }
    }
    values.BACKUP_TARGETS = targets.join(' ');

    if (!values.BACKUP_PASSPHRASE || values.BACKUP_PASSPHRASE === 'FILL-ME-IN') {
      values.BACKUP_PASSPHRASE = randomBytes(24).toString('base64url');
      console.log(`\nGenerated a passphrase:\n\n    ${values.BACKUP_PASSPHRASE}\n\nStore it OUTSIDE this host now (password manager, safe). Without it no backup can be opened.`);
    }
    values.BACKUP_ALERT_URL = await ask('\nURL to POST to when a backup fails (empty = none)', values.BACKUP_ALERT_URL);
    values.BACKUP_HEARTBEAT_URL = await ask('URL to ping after each successful backup (empty = none)', values.BACKUP_HEARTBEAT_URL);
  } finally {
    rl.close();
  }

  writeFileSync(file, renderConfig(values), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`\nWrote ${file}. Testing it:\n`);
  await checkConfig(stackDir);
  console.log(`\nSchedule the nightly run (crontab -e):\n  0 2 * * *  ${join(HERE, 'backup.sh')} ${resolve(stackDir)} >> ${join(resolve(stackDir), 'backup.log')} 2>&1`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `usage: node deploy/backup.mjs <command> [stack-dir] [options]

  setup    ask where backups go, write backup.env, test it
  check    validate backup.env and test every target   [--test-alert]
  run      snapshot, encrypt, upload, apply retention  [--local-only]
  list     archives on every target
  verify   fetch, decrypt and inspect the newest archive on every target
  restore  fetch an archive and unpack it beside the stack
           [--archive NAME|latest] [--from TARGET] [--apply --yes]

stack-dir defaults to the directory this script is in (the reference stack).`;

export function parseCli(argv) {
  const [command, ...rest] = argv;
  const opts = { command, stackDir: null, flags: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--archive' || a === '--from') opts.flags[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) opts.flags[a.slice(2)] = true;
    else if (!opts.stackDir) opts.stackDir = a;
    else throw new BackupError(`unexpected argument ${a}`);
  }
  opts.stackDir = resolve(opts.stackDir ?? HERE);
  return opts;
}

async function main(argv) {
  const { command, stackDir, flags } = parseCli(argv);
  if (!existsSync(stackDir)) throw new BackupError(`${stackDir} does not exist`);
  switch (command) {
    case 'setup':
      return setup(stackDir);
    case 'check':
      return checkConfig(stackDir, { testAlert: flags['test-alert'] === true });
    case 'run': {
      const status = await runBackup(stackDir, { localOnly: flags['local-only'] === true });
      if (!status.ok) process.exitCode = 1;
      return;
    }
    case 'list':
      return listAll(stackDir);
    case 'verify':
      return verifyBackups(stackDir);
    case 'restore':
      await restore(stackDir, { archive: flags.archive, from: flags.from, apply: flags.apply === true, yes: flags.yes === true });
      return;
    default:
      console.log(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof BackupError || err instanceof ConfigError || err instanceof TargetError) {
      console.error(`backup: ${err.message}`);
      process.exit(1);
    }
    throw err;
  });
}
