/**
 * Where an archive goes once it leaves the host. A target is one line in
 * `backup.env`'s BACKUP_TARGETS, and its shape says what kind it is:
 *
 *   /mnt/nas/0815                        a mounted folder — NAS over SMB/NFS, USB disk
 *   sftp://backup@nas.local/backups/0815 a NAS or server over SSH (port: sftp://u@h:2222/…)
 *   s3://bucket/prefix                   any S3-compatible store (endpoint in BACKUP_S3_ENDPOINT)
 *
 * Every target speaks the same four verbs (put, list, get, remove) and only
 * ever touches files named like this stack's archives: a NAS share is often
 * shared with other things, and retention must not be able to delete them.
 *
 * Uploads land under a temporary name and are renamed when complete, so an
 * interrupted copy never sits on the target looking like a good backup.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix } from 'node:path';
import { s3Client } from './s3.mjs';

export class TargetError extends Error {}

/** Run a command, collecting output; reject with stderr on a non-zero exit. */
function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) =>
      reject(new TargetError(err.code === 'ENOENT' ? `\`${cmd}\` is not installed on this host` : err.message)),
    );
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new TargetError(`${cmd} failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`)),
    );
    child.stdin.end(input ?? '');
  });
}

// ── mounted folder ───────────────────────────────────────────────────────────

/**
 * A folder on a mounted share. The folder must already exist: creating it
 * would turn an unmounted NAS into a silent local backup — `/mnt/nas` is an
 * empty directory on the system disk when the mount is missing, and every
 * archive would land on the very disk it is meant to protect against. For the
 * same reason a folder on the stack's own disk is refused unless
 * BACKUP_ALLOW_SAME_DISK=yes says that was meant.
 */
function folderTarget(dir, { stackDir, allowSameDisk }) {
  const check = () => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new TargetError(
        `${dir} does not exist. Is the NAS mounted? Create the folder on the share first — ` +
          'this tool does not create it, so that a missing mount cannot go unnoticed',
      );
    }
    if (!allowSameDisk && statSync(dir).dev === statSync(stackDir).dev) {
      throw new TargetError(
        `${dir} is on the same disk as the stack (${stackDir}); a disk failure would take both. ` +
          'Mount the NAS there, or set BACKUP_ALLOW_SAME_DISK=yes if this is intentional',
      );
    }
  };
  return {
    label: dir,
    async check() {
      check();
      const probe = join(dir, `.0815-write-test-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe);
    },
    async put(file, name) {
      check();
      const part = join(dir, `.${name}.part`);
      copyFileSync(file, part);
      renameSync(part, join(dir, name));
    },
    async list() {
      check();
      return readdirSync(dir);
    },
    async get(name, file) {
      copyFileSync(join(dir, name), file);
    },
    async remove(name) {
      rmSync(join(dir, name));
    },
  };
}

// ── SFTP ─────────────────────────────────────────────────────────────────────

/**
 * A NAS or server over SFTP, through the host's own `sftp` client. SFTP rather
 * than a shell, so an account restricted to file transfer — what Synology,
 * QNAP and a hardened backup server hand out — is enough. Batch mode: no
 * password prompt and no "accept this host key?" question at 2 a.m. The key
 * comes from BACKUP_SFTP_IDENTITY (or the user's ~/.ssh), and the host key
 * must be in known_hosts already — `check` says so when it is not.
 */
function sftpTarget(url, { identity }) {
  const u = new URL(url);
  if (!u.username) throw new TargetError(`${url}: name the account, e.g. sftp://backup@${u.hostname}${u.pathname}`);
  const dir = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '.';
  const dest = `${decodeURIComponent(u.username)}@${u.hostname}`;
  const args = ['-b', '-', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];
  if (u.port) args.push('-P', u.port);
  if (identity) args.push('-i', identity);
  // sftp batch syntax: quote paths so spaces survive; a leading '-' ignores that command's failure.
  const q = (p) => `"${p.replace(/(["\\])/g, '\\$1')}"`;
  const batch = (lines) => run('sftp', [...args, dest], { input: `${lines.join('\n')}\n` });

  return {
    label: `sftp://${dest}${u.port ? `:${u.port}` : ''}${dir}`,
    async check() {
      const probe = posix.join(dir, `.0815-write-test-${process.pid}`);
      const local = join(mkdtempSync(join(tmpdir(), '0815-sftp-')), 'probe');
      writeFileSync(local, 'ok');
      try {
        await batch([`put ${q(local)} ${q(probe)}`, `rm ${q(probe)}`]);
      } catch (err) {
        const hint = /Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(err.message)
          ? ` — add the host key first: ssh-keyscan ${u.port ? `-p ${u.port} ` : ''}${u.hostname} >> ~/.ssh/known_hosts (then compare its fingerprint with the NAS)`
          : /Permission denied/i.test(err.message)
            ? ' — the key is not accepted; install the public key for this account on the NAS, or point BACKUP_SFTP_IDENTITY at the right one'
            : '';
        throw new TargetError(`${err.message}${hint}`);
      } finally {
        rmSync(local, { force: true });
      }
    },
    async put(file, name) {
      const part = posix.join(dir, `.${name}.part`);
      await batch([`put ${q(file)} ${q(part)}`, `rename ${q(part)} ${q(posix.join(dir, name))}`]);
    },
    async list() {
      const out = await batch([`ls -1 ${q(dir)}`]);
      // Batch mode echoes each command as "sftp> …"; everything else is a path.
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('sftp>'))
        .map((l) => posix.basename(l));
    },
    async get(name, file) {
      await batch([`get ${q(posix.join(dir, name))} ${q(file)}`]);
    },
    async remove(name) {
      await batch([`rm ${q(posix.join(dir, name))}`]);
    },
  };
}

// ── S3 ───────────────────────────────────────────────────────────────────────

function s3Target(url, env) {
  const u = new URL(url);
  const bucket = u.hostname;
  const prefix = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
  const region = env.BACKUP_S3_REGION || 'us-east-1';
  const endpoint = env.BACKUP_S3_ENDPOINT || `https://s3.${region}.amazonaws.com`;
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new TargetError(`${url}: set BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY in backup.env`);
  }
  if (!/^https?:\/\//.test(endpoint)) throw new TargetError(`BACKUP_S3_ENDPOINT must be an http(s) URL, got ${endpoint}`);
  const client = s3Client({ endpoint, region, bucket, accessKeyId, secretAccessKey });
  const keyOf = (name) => (prefix ? `${prefix}/${name}` : name);

  return {
    label: `s3://${bucket}${prefix ? `/${prefix}` : ''} at ${new URL(endpoint).host}`,
    async check() {
      const probe = join(mkdtempSync(join(tmpdir(), '0815-s3-')), 'probe');
      writeFileSync(probe, 'ok');
      const key = keyOf(`.0815-write-test-${process.pid}`);
      try {
        await client.put(key, probe);
        // A bucket with Object Lock may refuse the delete — that is the point
        // of Object Lock, so it is not a failed check.
        await client.remove(key).catch(() => {});
      } finally {
        rmSync(probe, { force: true });
      }
    },
    // S3 PUTs are atomic: an interrupted upload leaves no object, so no .part dance.
    put: (file, name) => client.put(keyOf(name), file),
    list: async () => (await client.list(prefix ? `${prefix}/` : '')).map((k) => basename(k)),
    get: (name, file) => client.get(keyOf(name), file),
    remove: (name) => client.remove(keyOf(name)),
  };
}

/**
 * Turn one BACKUP_TARGETS entry into a target.
 * @param {string} spec
 * @param {{ env: Record<string,string>, stackDir: string }} ctx
 */
export function openTarget(spec, { env, stackDir }) {
  if (spec.startsWith('sftp://')) return sftpTarget(spec, { identity: env.BACKUP_SFTP_IDENTITY || undefined });
  if (spec.startsWith('s3://')) return s3Target(spec, env);
  if (spec.startsWith('file://')) spec = decodeURIComponent(new URL(spec).pathname);
  if (isAbsolute(spec)) {
    return folderTarget(spec.replace(/\/+$/, '') || '/', { stackDir, allowSameDisk: env.BACKUP_ALLOW_SAME_DISK === 'yes' });
  }
  throw new TargetError(
    `cannot tell what kind of target "${spec}" is — use an absolute folder (/mnt/nas/0815), sftp://user@host/path or s3://bucket/prefix`,
  );
}
