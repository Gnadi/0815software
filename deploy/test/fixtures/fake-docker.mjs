/**
 * A stand-in for `docker compose`, for deploy/test/backup-offsite.test.ts.
 *
 * CI has no Docker, and the backup tool's whole job is talking to it. So this
 * script answers the handful of compose commands backup.mjs uses — ps, exec,
 * cp, run, stop, create, up — against plain folders: FAKE_DOCKER_ROOT/<svc>/
 * is a container's filesystem, and a container path under /data maps into it.
 * `node -e …` runs for real, with the container's env, so the code backup.mjs
 * sends into containers is exercised, not mocked. `npm run backup` does what
 * every package's scripts/backup.mjs does (snapshot + files folders), which
 * deploy/test/backup.test.ts pins for the real scripts.
 *
 * FAKE_DOCKER_ROOT/services.json: { "<svc>": { running, node, script, fail, env } }
 * Every invocation is appended to FAKE_DOCKER_ROOT/calls.log.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.FAKE_DOCKER_ROOT;
const services = JSON.parse(readFileSync(join(root, 'services.json'), 'utf8'));
const argv = process.argv.slice(2);
appendFileSync(join(root, 'calls.log'), `${JSON.stringify(argv)}\n`);

if (argv[0] !== 'compose') process.exit(64);
const [cmd, ...rest] = argv.slice(1);

const mapPath = (svc, p, binds = {}) => {
  for (const [from, to] of Object.entries(binds)) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p.startsWith('/data') ? join(root, svc, p) : p;
};

function envOf(svc, extra, binds) {
  const env = { PATH: process.env.PATH };
  for (const [k, v] of Object.entries({ BACKUP_DIR: '/data/backups', DATABASE_PATH: '/data/data.db', ...services[svc].env, ...extra })) {
    env[k] = mapPath(svc, v, binds);
  }
  return env;
}

function runIn(svc, command, extraEnv, binds = {}) {
  const s = services[svc];
  if (!s) return 1;
  const env = envOf(svc, extraEnv, binds);
  const cwd = join(root, svc, 'app');
  mkdirSync(cwd, { recursive: true });
  if (command[0] === 'node') {
    if (!s.node) {
      process.stderr.write('OCI runtime exec failed: "node": executable file not found\n');
      return 126;
    }
    const r = spawnSync(process.execPath, command.slice(1), { cwd, env, stdio: 'inherit' });
    return r.status ?? 1;
  }
  if (command.join(' ') === 'npm run --silent backup') {
    if (s.fail) {
      process.stderr.write('database is locked\n');
      return 1;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(env.BACKUP_DIR, { recursive: true });
    copyFileSync(env.DATABASE_PATH, join(env.BACKUP_DIR, `backup-${stamp}.db`));
    for (const [k, v] of Object.entries(env)) {
      if (!k.endsWith('_DIR') || k === 'BACKUP_DIR' || !existsSync(v)) continue;
      cpSync(v, join(env.BACKUP_DIR, `${k.slice(0, -4).toLowerCase()}-${stamp}`), { recursive: true });
    }
    return 0;
  }
  process.stderr.write(`fake docker: unsupported command ${command.join(' ')}\n`);
  return 127;
}

/** Parse `-T`, `-e K=V`, `-v a:b[:ro]`, `--entrypoint x`, `--rm`, `--no-deps` up to the service name. */
function parseOpts(args) {
  const env = {};
  const binds = {};
  let entrypoint;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-T' || a === '--rm' || a === '--no-deps') continue;
    if (a === '-e') {
      const [k, ...v] = args[++i].split('=');
      env[k] = v.join('=');
    } else if (a === '-v') {
      const [host, ctr] = args[++i].split(':');
      binds[ctr] = host;
    } else if (a === '--entrypoint') entrypoint = args[++i];
    else break;
  }
  return { env, binds, entrypoint, svc: args[i], command: args.slice(i + 1) };
}

let code = 0;
switch (cmd) {
  case 'ps':
    for (const [name, s] of Object.entries(services)) if (s.running) console.log(name);
    break;
  case 'exec': {
    const o = parseOpts(rest);
    if (!services[o.svc]?.running) code = 1;
    else code = runIn(o.svc, o.command, o.env);
    break;
  }
  case 'run': {
    const o = parseOpts(rest);
    code = runIn(o.svc, [o.entrypoint, ...o.command], o.env, o.binds);
    break;
  }
  case 'cp': {
    const [svc, p] = rest[0].split(':');
    const src = mapPath(svc, p);
    if (!existsSync(src)) {
      process.stderr.write(`no such file: ${p}\n`);
      code = 1;
    } else cpSync(src, rest[1], { recursive: true });
    break;
  }
  case 'stop':
  case 'create':
  case 'up':
    break;
  default:
    code = 64;
}
process.exit(code);
