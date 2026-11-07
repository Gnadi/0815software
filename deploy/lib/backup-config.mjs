/**
 * `backup.env` — the one file an administrator edits to say where a stack's
 * backups go and how long they are kept. It sits beside the stack's `.env`,
 * is written by `provision.mjs` with a generated passphrase, and can be
 * (re)written interactively by `node deploy/backup.mjs setup`.
 *
 * It is a separate file from `.env` on purpose: `.env` goes INTO every archive
 * (a restored stack needs its secrets), while backup.env holds the passphrase
 * that opens the archive and the credentials of the target — the two things
 * that must live somewhere else, or a stolen archive opens itself.
 *
 * Fail closed, loudly: a typo in a key, a short passphrase or a retention
 * count that is not a number stops the run with a message, rather than
 * producing a backup that is quietly unencrypted, unkept or nowhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = 'backup.env';
export const PLACEHOLDER = 'FILL-ME-IN';
export const MIN_PASSPHRASE = 16;

/** Every key backup.env may hold, with its default. Anything else is a typo. */
export const KEYS = {
  BACKUP_TARGETS: '',
  BACKUP_PASSPHRASE: '',
  BACKUP_PASSPHRASE_FILE: '',
  BACKUP_KEEP_DAILY: '7',
  BACKUP_KEEP_WEEKLY: '4',
  BACKUP_KEEP_MONTHLY: '12',
  BACKUP_KEEP_LOCAL: '3',
  BACKUP_ALERT_URL: '',
  BACKUP_HEARTBEAT_URL: '',
  BACKUP_ALLOW_SAME_DISK: '',
  BACKUP_SFTP_IDENTITY: '',
  BACKUP_S3_ENDPOINT: '',
  BACKUP_S3_REGION: '',
  BACKUP_S3_ACCESS_KEY_ID: '',
  BACKUP_S3_SECRET_ACCESS_KEY: '',
  BACKUP_WORK_DIR: '',
};

export class ConfigError extends Error {}

/**
 * KEY=VALUE lines; `#` comments; optional single or double quotes around the value.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new ConfigError(`${CONFIG_FILE} line ${i + 1}: expected KEY=value, got "${line}"`);
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  });
  return out;
}

function count(env, key, min) {
  const raw = env[key];
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a whole number, got "${raw}"`);
  const n = Number(raw);
  if (n < min) throw new ConfigError(`${key} must be at least ${min}, got ${n}`);
  return n;
}

function httpUrl(env, key) {
  const raw = env[key];
  if (!raw) return null;
  if (!/^https?:\/\/[^\s]+$/.test(raw)) throw new ConfigError(`${key} must be an http(s) URL, got "${raw}"`);
  return raw;
}

/**
 * Load and validate a stack's backup configuration. Values from the process
 * environment override the file, so a one-off run can point elsewhere
 * without editing it.
 */
export function loadConfig(stackDir, processEnv = process.env) {
  const file = join(stackDir, CONFIG_FILE);
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  for (const key of Object.keys(fromFile)) {
    if (!(key in KEYS)) {
      throw new ConfigError(`${CONFIG_FILE}: unknown setting ${key} (known: ${Object.keys(KEYS).join(', ')})`);
    }
  }
  const fromProcess = Object.fromEntries(
    Object.keys(KEYS)
      .filter((k) => processEnv[k] !== undefined)
      .map((k) => [k, processEnv[k]]),
  );
  const env = { ...KEYS, ...fromFile, ...fromProcess };

  const targets = env.BACKUP_TARGETS.split(/\s+/).filter(Boolean);

  let passphrase = env.BACKUP_PASSPHRASE;
  if (env.BACKUP_PASSPHRASE_FILE) {
    if (!existsSync(env.BACKUP_PASSPHRASE_FILE)) {
      throw new ConfigError(`BACKUP_PASSPHRASE_FILE ${env.BACKUP_PASSPHRASE_FILE} does not exist`);
    }
    passphrase = readFileSync(env.BACKUP_PASSPHRASE_FILE, 'utf8').trim();
  }
  if (passphrase === PLACEHOLDER) passphrase = '';
  if (targets.length > 0 && !passphrase) {
    throw new ConfigError(
      `BACKUP_PASSPHRASE is not set. Archives leave this host and are always encrypted; ` +
        `generate one with: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`,
    );
  }
  if (passphrase && passphrase.length < MIN_PASSPHRASE) {
    throw new ConfigError(`BACKUP_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters`);
  }
  if (targets.some((t) => t === PLACEHOLDER)) {
    throw new ConfigError(`BACKUP_TARGETS still says ${PLACEHOLDER} — name the NAS folder, sftp:// or s3:// target`);
  }

  return {
    file,
    fileExists: existsSync(file),
    env,
    targets,
    passphrase,
    retention: {
      daily: count(env, 'BACKUP_KEEP_DAILY', 1),
      weekly: count(env, 'BACKUP_KEEP_WEEKLY', 0),
      monthly: count(env, 'BACKUP_KEEP_MONTHLY', 0),
    },
    keepLocal: count(env, 'BACKUP_KEEP_LOCAL', 1),
    alertUrl: httpUrl(env, 'BACKUP_ALERT_URL'),
    heartbeatUrl: httpUrl(env, 'BACKUP_HEARTBEAT_URL'),
  };
}

/**
 * The commented backup.env a new stack starts with. `values` fills in what is
 * known; everything else keeps its default and its explanation, so the file
 * documents itself for whoever opens it next.
 */
export function renderConfig(values = {}) {
  const v = (key) => values[key] ?? KEYS[key];
  return `# Backups for this stack — read by <repo>/deploy/backup.mjs (and backup.sh).
#
#   node <repo>/deploy/backup.mjs setup <this dir>   # answer a few questions, writes this file
#   node <repo>/deploy/backup.mjs check <this dir>   # test every target before the first night
#
# Keep a copy of BACKUP_PASSPHRASE OUTSIDE this host (password manager, sealed
# envelope in the safe). Every archive is encrypted with it; without it no
# backup can be opened — not by you, not by us.

# Where archives go. One or more, separated by spaces — two places is better
# than one (e.g. the NAS in the office AND a bucket in another building).
#   /mnt/nas/0815-backups                 a mounted NAS share (SMB/NFS) or USB disk
#   sftp://backup@nas.local/backups/0815  a NAS or server over SSH/SFTP
#   s3://my-bucket/0815                   any S3-compatible storage (see BACKUP_S3_*)
BACKUP_TARGETS=${v('BACKUP_TARGETS')}

# Encrypts every archive (AES-256-GCM). At least ${MIN_PASSPHRASE} characters.
BACKUP_PASSPHRASE=${v('BACKUP_PASSPHRASE')}
# …or read it from a file instead (wins over BACKUP_PASSPHRASE when set):
BACKUP_PASSPHRASE_FILE=${v('BACKUP_PASSPHRASE_FILE')}

# How many archives each target keeps: the newest of each day / ISO week /
# month, counting back from the newest. Defaults: 7 days, 4 weeks, 12 months.
BACKUP_KEEP_DAILY=${v('BACKUP_KEEP_DAILY')}
BACKUP_KEEP_WEEKLY=${v('BACKUP_KEEP_WEEKLY')}
BACKUP_KEEP_MONTHLY=${v('BACKUP_KEEP_MONTHLY')}
# Snapshots kept on each container's own volume, for a quick rollback after a
# bad update without fetching anything.
BACKUP_KEEP_LOCAL=${v('BACKUP_KEEP_LOCAL')}

# Told when a backup FAILS: a JSON POST (works with ntfy, Slack/Teams/Mattermost
# incoming webhooks, n8n, …).
BACKUP_ALERT_URL=${v('BACKUP_ALERT_URL')}
# Pinged after every SUCCESSFUL run (healthchecks.io, Uptime Kuma push monitor,
# …). That service alerts you when the ping stops — which is the only way to
# hear about a backup that never ran at all (host off, cron removed).
BACKUP_HEARTBEAT_URL=${v('BACKUP_HEARTBEAT_URL')}

# A folder target on the same disk as the stack is refused, because it would
# not survive the disk. Set to yes only if that is really what you want.
BACKUP_ALLOW_SAME_DISK=${v('BACKUP_ALLOW_SAME_DISK')}

# sftp:// targets: private key to log in with (default: the user's ~/.ssh keys).
BACKUP_SFTP_IDENTITY=${v('BACKUP_SFTP_IDENTITY')}

# s3:// targets. Endpoint of the provider, e.g. https://fsn1.your-objectstorage.com
# (Hetzner), https://s3.eu-central-1.wasabisys.com, http://nas.local:9000 (MinIO).
# Empty = AWS in BACKUP_S3_REGION.
BACKUP_S3_ENDPOINT=${v('BACKUP_S3_ENDPOINT')}
BACKUP_S3_REGION=${v('BACKUP_S3_REGION')}
BACKUP_S3_ACCESS_KEY_ID=${v('BACKUP_S3_ACCESS_KEY_ID')}
BACKUP_S3_SECRET_ACCESS_KEY=${v('BACKUP_S3_SECRET_ACCESS_KEY')}

# Scratch space while an archive is built (default: .backup-work in this dir).
# Needs room for about twice the size of all databases and files together.
BACKUP_WORK_DIR=${v('BACKUP_WORK_DIR')}
`;
}
