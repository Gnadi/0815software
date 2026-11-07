/**
 * A stand-in for the `sftp` client, for deploy/test/backup-offsite.test.ts:
 * reads the batch from stdin like `sftp -b -` and runs put/get/rename/rm/ls
 * against FAKE_SFTP_ROOT, where the remote's "/" is. Refuses to run without
 * BatchMode=yes — a prompt at 2 a.m. is a backup that hangs forever.
 */
import { appendFileSync, copyFileSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.FAKE_SFTP_ROOT;
const args = process.argv.slice(2);
appendFileSync(join(root, '..', 'sftp-calls.log'), `${JSON.stringify(args)}\n`);
if (!args.includes('BatchMode=yes') || args[0] !== '-b' || args[1] !== '-') {
  process.stderr.write('interactive sftp is not allowed here\n');
  process.exit(2);
}
const remote = (p) => join(root, p);
const words = (line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, '$1'));

for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
  console.log(`sftp> ${line}`);
  const [cmd, a, b] = words(line);
  try {
    if (cmd === 'put') copyFileSync(a, remote(b));
    else if (cmd === 'get') copyFileSync(remote(a), b);
    else if (cmd === 'rename') renameSync(remote(a), remote(b));
    else if (cmd === 'rm') rmSync(remote(a));
    else if (cmd === 'ls') for (const n of readdirSync(remote(b ?? a))) if (!n.startsWith('.')) console.log(`${a === '-1' ? b : a}/${n}`);
    else throw new Error(`unsupported: ${cmd}`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
