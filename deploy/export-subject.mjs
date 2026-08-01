#!/usr/bin/env node
/**
 * Answer a subject access request against ONE customer's stack (GDPR Art. 15
 * and 20).
 *
 *   node deploy/export-subject.mjs --manifest ./customers/xy/manifest.json \
 *     --subject ada@example.com
 *
 * A controller who receives "send me everything you hold about me" has a month
 * to answer it, and reading four SQLite files by hand is not an answer. This
 * asks every service in the stack that can be asked, and assembles one JSON
 * document with the reply.
 *
 * It is deliberately explicit about its own limits. The report lists what was
 * covered, what was skipped and why, so nobody mistakes it for the whole
 * answer: the MODULES hold the domain records (this person's invoices, their
 * tickets, their time entries) and have no export endpoint yet. Those have to
 * be added by hand, and the report says so, per module, rather than quietly
 * returning a document that looks complete.
 *
 * Run against the running stack from the host, with the platform service
 * token from the stack's .env.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const USAGE = `Usage:
  node deploy/export-subject.mjs --manifest <path> --subject <email> [--out <file>]

Required:
  --manifest <path>   manifest.json of the customer stack
  --subject <email>   the data subject; an email address, or a PS-11 party id

Optional:
  --out <file>        write the report here (default: stdout)
  --base <url>        reach the services at this base instead of the stack's
                      public domain — e.g. http://localhost when tunnelling
  --token <value>     the stack's PLATFORM_SERVICE_TOKEN; read from the .env
                      beside the manifest when omitted`;

/** Services that can answer for a subject, and what identifies them there. */
const EXPORTERS = {
  'ps-01-identity': 'the platform user account, its roles, and its login history',
  'ps-03-notification-hub': 'messages sent to this address, with their bodies',
  'ps-07-audit-log': 'audit events they caused, and events that mention them',
  'ps-11-customers': 'the party master record, its references and merged duplicates',
};

/** Services with no subject-addressable personal data of their own. */
const NOT_APPLICABLE = {
  'ps-02-workflow-engine': 'holds caller-supplied payloads, bound at the source module',
  'ps-04-ai-platform': 'holds caller-supplied prompts and documents, bound at the source module',
  'ps-05-integration-hub': 'holds third-party credentials, not data about the subject',
  'ps-06-file-storage': 'holds opaque objects; the owning module knows which are theirs',
  'ps-08-payments': 'holds pseudonymous references and amounts — financial records, kept for statutory periods',
  'ps-09-search': 'is a mirror of module records; export from the source instead',
  'ps-10-number': 'holds counters only',
};

function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    raw[arg.slice(2)] = value;
    i += 1;
  }
  if (!raw.manifest) throw new Error(`missing --manifest\n\n${USAGE}`);
  if (!raw.subject) throw new Error(`missing --subject\n\n${USAGE}`);
  return { help: false, ...raw };
}

/** The stack's machine token, from the .env next to the manifest. */
function tokenFrom(manifestPath) {
  const envPath = resolve(dirname(manifestPath), '.env');
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('PLATFORM_SERVICE_TOKEN='));
  if (!line) throw new Error(`no PLATFORM_SERVICE_TOKEN in ${envPath} — pass --token`);
  return line.slice('PLATFORM_SERVICE_TOKEN='.length).trim();
}

async function askService(url, subject, token) {
  const target = `${url}/api/export?subject=${encodeURIComponent(subject)}`;
  const res = await fetch(target, { headers: { 'X-Service-Token': token } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Ask every source in the stack and assemble the answer.
 *
 * @param {any} manifest the stack's manifest.json
 * @param {{
 *   subject: string,
 *   token: string,
 *   base?: string,
 *   fetchImpl?: (url: string, init?: { headers?: Record<string, string> }) =>
 *     Promise<{ ok: boolean, status: number, json: () => Promise<any> }>,
 * }} options the injectable fetch keeps the tests offline, as elsewhere here
 * @returns {Promise<{ sources: any[], gaps: any[] }>}
 */
export async function collect(manifest, { subject, token, base, fetchImpl = fetch }) {
  const sources = [];
  const gaps = [];

  for (const service of manifest.services) {
    const holds = EXPORTERS[service.id];
    if (!holds) {
      gaps.push({
        source: service.id,
        kind: 'service',
        reason: NOT_APPLICABLE[service.id] ?? 'has no subject export',
        action: 'none — nothing here is addressable by a data subject',
      });
      continue;
    }
    const url = base
      ? `${base.replace(/\/+$/, '')}${service.routePrefix}`
      : `https://${manifest.domain}${service.routePrefix}`;
    try {
      const res = await fetchImpl(`${url}/api/export?subject=${encodeURIComponent(subject)}`, {
        headers: { 'X-Service-Token': token },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      sources.push({ source: service.id, holds, ...(await res.json()) });
    } catch (err) {
      // A source that could not be asked is NOT an empty source — saying so is
      // the difference between an incomplete answer and a wrong one.
      gaps.push({
        source: service.id,
        kind: 'service',
        reason: `could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        action: 'retry with the stack running, or export this service by hand',
      });
    }
  }

  // The modules hold the domain records. They have no export endpoint yet, so
  // the report names each one and what has to be looked at instead of leaving
  // a hole the reader cannot see.
  for (const mod of manifest.modules) {
    gaps.push({
      source: mod.id,
      kind: 'module',
      reason: 'modules have no subject export endpoint yet',
      action: `inspect this module's database by hand: docker compose exec ${mod.subdomain} node -e "…" — the records keyed by the subject's email or customer id`,
    });
  }

  return { sources, gaps };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const manifestPath = resolve(args.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const token = args.token ?? tokenFrom(manifestPath);

  collect(manifest, { subject: args.subject, token, base: args.base })
    .then(({ sources, gaps }) => {
      const report = {
        subject: args.subject,
        customer: manifest.customer,
        assembled_at: new Date().toISOString(),
        assembled_by: 'deploy/export-subject.mjs',
        complete: gaps.every((gap) => gap.action.startsWith('none')),
        sources,
        gaps,
      };
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (args.out) {
        writeFileSync(resolve(args.out), json);
        console.log(`[export] ${sources.length} source(s) answered, ${gaps.length} gap(s) — ${args.out}`);
        if (!report.complete) {
          console.log('[export] INCOMPLETE — see "gaps": the modules hold domain records this cannot reach yet.');
        }
      } else {
        process.stdout.write(json);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
