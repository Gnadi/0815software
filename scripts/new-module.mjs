#!/usr/bin/env node
/**
 * Scaffold a new Business Module that already follows every convention of the
 * catalogue — so whoever (or whatever) writes the domain next starts from the
 * right pattern instead of copying the nearest module's quirks.
 *
 *   node scripts/new-module.mjs --n 18 --slug project-tasks \
 *     --title "Projects & Tasks" --label Projects \
 *     --description "Projects, tasks and milestones between the offer and the invoice."
 *
 * What it produces, in modules/mod-<n>-<slug>/ (or --out):
 *
 *  - The COPY-IN files every module carries byte-identical apart from its own
 *    number — auth, SSO, shell handoff, transport hardening, the boot guard,
 *    the shell summary contract, the backup script, the shared tests — copied
 *    from the reference module (MOD-03), so they cannot be re-invented
 *    slightly differently. Multi-user access (docs/ACCESS-LEVELS.md) comes with
 *    them: sessions carry a level, and server/access.ts is the policy.
 *  - A working example domain from scripts/module-template/ — items with a
 *    status and an append-only history, a React screen that hides what the
 *    signed-in person may not do, and tests for both — to be replaced.
 *
 * Before it writes anything it asks whether the topic is a module at all:
 * `overlapCandidates` compares the title, slug and description with every
 * existing module's registry entry and README and lists the ones that already
 * cover — or deliberately exclude — the same ground. With a candidate on the
 * list it refuses unless --justify says why the topic is not an extension of
 * that module; the reason is written into the new README. (Absences looked like
 * a module of their own and belonged in MOD-11, next to the time they replace.)
 *
 * With --register it also adds the registry entry (modules/registry.json) and
 * a placeholder copy block (src/data/modules.ts), and prints what is still
 * left to do by hand. Without it, nothing outside the new directory changes.
 *
 * Plain ESM, no dependencies: it runs before anything is installed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'scripts', 'module-template');
const REFERENCE_ID = 'mod-03-inventory-management';
const REFERENCE = join(ROOT, 'modules', REFERENCE_ID);

/**
 * Files every module shares, taken from the reference module. Each is
 * identical across the catalogue apart from the module's own number — if one
 * of them needs to change, change it in every module, not only here.
 */
export const COPY_IN = [
  '.npmrc',
  // The same dependencies as the reference, so the same lockfile: `npm ci`
  // works from the first commit, and npm's file:-link install (install-links)
  // does not have to resolve a tree from scratch.
  'package-lock.json',
  'LICENSE',
  'tsconfig.json',
  'tsconfig.server.json',
  'scripts/backup.mjs',
  'server/auth.ts',
  'server/sso.ts',
  'server/handoff.ts',
  'server/hardening.ts',
  'server/guard.ts',
  'shared/summary.ts',
  'src/styles.css',
  'src/access.tsx',
  'src/components/Login.tsx',
  'test/access.test.ts',
  'test/handoff.test.ts',
  'test/transport-hardening.test.ts',
  'test/config-env.test.ts',
  'test/upgrade.test.ts',
];

/**
 * Words that name the same thing, so "Urlaub" finds a README that says
 * "vacation". Small on purpose, English and German, and only words that are
 * not also everyday English ("leave", "order", "support" are verbs and nouns
 * of every README). A group counts as one term, named by its first word.
 */
export const SYNONYMS = [
  ['absence', 'absences', 'vacation', 'vacations', 'holiday', 'holidays', 'time-off', 'sick', 'urlaub', 'abwesenheit', 'abwesenheiten', 'krankenstand', 'feiertag', 'feiertage'],
  ['timesheet', 'timesheets', 'timer', 'zeiterfassung', 'arbeitszeit'],
  ['invoice', 'invoices', 'invoicing', 'billing', 'rechnung', 'rechnungen', 'faktura'],
  ['stock', 'inventory', 'warehouse', 'warehouses', 'lager', 'lagerhaltung'],
  ['orders', 'auftrag', 'aufträge', 'auftraege'],
  ['delivery', 'deliveries', 'lieferschein', 'lieferscheine', 'shipping', 'versand'],
  ['offer', 'offers', 'quote', 'quotes', 'quotation', 'angebot', 'angebote'],
  ['ticket', 'tickets', 'helpdesk'],
  ['customer', 'customers', 'kunde', 'kunden'],
  ['contact', 'contacts', 'kontakt', 'kontakte', 'crm'],
  ['employee', 'employees', 'staff', 'mitarbeiter'],
  ['purchase', 'purchasing', 'procurement', 'einkauf', 'bestellung', 'supplier', 'suppliers', 'lieferant', 'lieferanten'],
  ['contracts', 'vertrag', 'verträge', 'vertraege'],
  ['expense', 'expenses', 'spesen', 'reisekosten', 'reimbursement', 'beleg', 'belege'],
  ['project', 'projects', 'projekt', 'projekte'],
  ['task', 'tasks', 'aufgabe', 'aufgaben', 'milestone', 'milestones'],
  ['payment', 'payments', 'sepa', 'zahlung', 'zahlungen', 'dunning', 'mahnung', 'mahnwesen'],
  ['appointment', 'appointments', 'termin', 'termine', 'terminbuchung'],
  ['asset', 'assets', 'maintenance', 'wartung', 'anlage', 'anlagen', 'fleet', 'fuhrpark', 'vehicle', 'vehicles'],
];

/** Words too common in this catalogue to say anything about a topic. */
const STOP = new Set(
  ('a an and the of for to in on with without by from or not no is are be as at it its this that each every one all any ' +
    'module modules app apps system software business standard simple based manage management tool tools data list lists ' +
    'request requests item items status history page view screen user users base new own way time times ' +
    'und oder der die das mit für von zu im ein eine nicht auf').split(' '),
);

/** The words of a text, lower-case, stop words dropped, synonyms folded to one term — repeats kept. */
export function wordsOf(text) {
  const words = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9äöüß-]+/)) {
    for (const word of raw.includes('-') ? [raw, ...raw.split('-')] : [raw]) {
      if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
      const group = SYNONYMS.find((g) => g.includes(word));
      words.push(group ? group[0] : word);
    }
  }
  return words;
}

/** The distinct terms a text is about. */
export function termsOf(text) {
  return new Set(wordsOf(text));
}

/** The README's "Out of scope" section — where a module says what it leaves to others. */
function outOfScope(readme) {
  const match = /^## Out of scope\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
  return match ? match[1] : '';
}

/**
 * Existing modules that may already be the home of the topic — the question
 * to answer before a new package exists.
 *
 * Every README mentions customers, invoices and documents somewhere, so a
 * mention says little. A module COVERS a term when the term is in its title or
 * label, or — for the named concepts in SYNONYMS ("receipt" means goods
 * received in one README and an expense in another, so plain words do not
 * count) — when its README uses it at least five times and at least three
 * times as often as the catalogue's average README: what the module is about,
 * not what it passes by. Terms named in a module's "Out of scope" are reported
 * beside a candidate: the module chose not to cover them, which is a reason
 * to look, not proof either way (MOD-11 listed leave as out of scope; absences
 * went into MOD-11 all the same).
 *
 * `catalogue` is `[{ id, title, label, readme }]`; the result is ordered by
 * score, strongest first.
 */
export function overlapCandidates(topic, catalogue) {
  // Short plain words ("due", "per") match everything; a named concept counts at any length.
  const concept = (t) => SYNONYMS.some((g) => g[0] === t);
  const wanted = new Set(
    [...termsOf(`${topic.title} ${topic.slug} ${topic.label ?? ''} ${topic.description ?? ''}`)].filter((t) => concept(t) || t.length >= 5),
  );
  const docs = catalogue.map((m) => {
    const scope = outOfScope(m.readme);
    const counts = new Map();
    for (const w of wordsOf(m.readme.replace(scope, ''))) counts.set(w, (counts.get(w) ?? 0) + 1);
    return { ...m, name: termsOf(`${m.title} ${m.label}`), counts, excluded: termsOf(scope) };
  });
  const mean = (term) => docs.reduce((sum, d) => sum + (d.counts.get(term) ?? 0), 0) / Math.max(1, docs.length);
  return docs
    .map((d) => {
      const covers = [...wanted].filter(
        (t) => d.name.has(t) || (concept(t) && (d.counts.get(t) ?? 0) >= 5 && (d.counts.get(t) ?? 0) >= 3 * mean(t)),
      );
      const excluded = [...wanted].filter((t) => concept(t) && d.excluded.has(t) && !covers.includes(t));
      const score = covers.reduce((sum, t) => sum + (d.name.has(t) ? 3 : 1), 0) + excluded.length;
      return { id: d.id, title: d.title, score, covers, outOfScope: excluded };
    })
    .filter((c) => c.covers.length > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The catalogue as overlapCandidates reads it: registry entries with their READMEs. */
export function readCatalogue(root = ROOT) {
  const registry = JSON.parse(readFileSync(join(root, 'modules', 'registry.json'), 'utf8'));
  return registry.modules.map((m) => {
    const path = join(root, 'modules', m.id, 'README.md');
    return { id: m.id, title: m.title, label: m.label, readme: existsSync(path) ? readFileSync(path, 'utf8') : '' };
  });
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function usage(problem) {
  if (problem) console.error(`new-module: ${problem}\n`);
  console.error(
    'usage: node scripts/new-module.mjs --n <number> --slug <slug> --title <title> --label <label>\n' +
      '         [--description <text>] [--port <port>] [--scope "2–3 WKS"] [--out <dir>] [--register]\n' +
      '         [--justify <why this is not part of an existing module>]',
  );
  process.exit(problem ? 1 : 0);
}

/**
 * Every value a template or copy-in can name, derived from the options.
 *
 * @param {{ n: number, slug: string, title: string, label: string, description: string, port: number, justification?: string }} options
 */
export function tokensFor({ n, slug, title, label, description, port, justification }) {
  const num = String(n).padStart(2, '0');
  return {
    ID: `mod-${num}-${slug}`,
    ID_SHORT: `mod-${num}`,
    NUM: num,
    N: `MOD-${num}`,
    SLUG: slug,
    TITLE: title,
    TITLE_UPPER: title.toUpperCase(),
    TITLE_LOWER: title.toLowerCase(),
    LABEL: label,
    DESCRIPTION: description,
    JUSTIFICATION: justification ?? 'No existing module covered this topic when it was generated (scripts/new-module.mjs checks the catalogue).',
    PORT: String(port),
    VITE_PORT: String(5170 + Number(n)),
  };
}

function fill(text, tokens) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    if (!(key in tokens)) throw new Error(`unknown template token ${whole}`);
    return tokens[key];
  });
}

/** A copy-in, renumbered: the reference module's own number becomes the new one. */
export function renumber(text, tokens) {
  return text
    .replaceAll(REFERENCE_ID, tokens.ID)
    .replaceAll('MOD-03 · INVENTORY MANAGEMENT', `${tokens.N} · ${tokens.TITLE_UPPER}`)
    .replaceAll('MOD-03 Inventory Management', `${tokens.N} ${tokens.TITLE}`)
    .replaceAll('mod-03', tokens.ID_SHORT)
    .replaceAll('mod03', `mod${tokens.NUM}`)
    .replaceAll('MOD-03', tokens.N);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Write the package. Returns the paths written, relative to `out`. */
export function scaffold(options, out) {
  const tokens = tokensFor(options);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} already exists and is not empty`);
  const written = [];
  const write = (rel, content) => {
    const target = join(out, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(rel);
  };
  for (const file of walk(TEMPLATE)) write(relative(TEMPLATE, file), fill(readFileSync(file, 'utf8'), tokens));
  for (const rel of COPY_IN) write(rel, renumber(readFileSync(join(REFERENCE, rel), 'utf8'), tokens));
  return written.sort();
}

/** The registry entry for the new module, in catalogue order. */
export function registryEntry(options) {
  const tokens = tokensFor(options);
  return {
    id: tokens.ID,
    n: tokens.N,
    slug: options.slug,
    title: options.title,
    label: options.label,
    defaultPort: options.port,
    scope: options.scope,
    services: { required: [], optional: ['ps-01-identity', 'ps-07-audit-log'] },
    env: { required: [], optional: ['SHELL_ORIGIN'], secrets: ['ADMIN_PASSWORD', 'SESSION_SECRET'] },
    constraints: {
      supportsSso: true,
      embeddable: true,
      needsPublicBaseUrl: false,
      acceptsSourceDb: false,
      publishesReportViews: false,
    },
  };
}

function register(options) {
  const registryPath = join(ROOT, 'modules', 'registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const entry = registryEntry(options);
  registry.modules.push(entry);
  registry.modules.sort((a, b) => a.n.localeCompare(b.n));
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const copyPath = join(ROOT, 'src', 'data', 'modules.ts');
  const copy = readFileSync(copyPath, 'utf8');
  const end = copy.lastIndexOf('\n};');
  if (end < 0) throw new Error('src/data/modules.ts: could not find the end of the presentation table');
  const block = [
    `  '${entry.id}': {`,
    `    body: ${JSON.stringify(options.description)},`,
    `    overview: ${JSON.stringify(`${options.description} (Placeholder overview — write the real one.)`)},`,
    `    features: [${JSON.stringify('Placeholder feature — list the real ones')}],`,
    `    screen: { variant: 'table', accent: '#6B8FB5', nav: ['Items'], columns: ['#', 'Title', 'Status'], rows: [['1', 'Example', 'Open']], statuses: ['Open'] },`,
    '  },',
  ].join('\n');
  writeFileSync(copyPath, `${copy.slice(0, end)}\n${block}${copy.slice(end)}`);
}

function main() {
  const { values } = parseArgs({
    options: {
      n: { type: 'string' },
      slug: { type: 'string' },
      title: { type: 'string' },
      label: { type: 'string' },
      description: { type: 'string' },
      port: { type: 'string' },
      scope: { type: 'string', default: '2–3 WKS' },
      out: { type: 'string' },
      register: { type: 'boolean', default: false },
      justify: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) usage();
  for (const required of ['n', 'slug', 'title', 'label']) if (!values[required]) usage(`--${required} is required`);

  const n = Number(values.n);
  if (!Number.isInteger(n) || n < 1 || n > 99) usage('--n must be a whole number between 1 and 99');
  if (!SLUG.test(values.slug)) usage('--slug must be lower-case letters, digits and dashes');
  const port = values.port ? Number(values.port) : 3000 + n;
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage('--port must be a valid port');

  const options = {
    n,
    slug: values.slug,
    title: values.title,
    label: values.label,
    description: values.description ?? `${values.title}.`,
    port,
    scope: values.scope,
    justification: values.justify?.trim() || undefined,
  };
  const tokens = tokensFor(options);

  // First the question whether this is a module at all.
  const candidates = overlapCandidates(options, readCatalogue());
  if (candidates.length > 0) {
    const lines = candidates.map(
      (c) =>
        `  ${c.id.padEnd(32)} ${c.covers.length > 0 ? `covers: ${c.covers.join(', ')}` : ''}${
          c.outOfScope.length > 0 ? `${c.covers.length > 0 ? ' · ' : ''}lists as out of scope: ${c.outOfScope.join(', ')}` : ''
        }`,
    );
    console.error(`new-module: these modules already touch "${options.title}":\n${lines.join('\n')}\n`);
    if (!options.justification) {
      usage(
        'extend one of them instead (read its README: the invariants and "Out of scope"), or\n' +
          '  re-run with --justify "<why this is not part of MOD-xx>" — the reason goes into the new README',
      );
    }
    console.error(`going ahead: ${options.justification}\n`);
  }

  const registry = JSON.parse(readFileSync(join(ROOT, 'modules', 'registry.json'), 'utf8'));
  const clash = registry.modules.find(
    (m) => m.n === tokens.N || m.slug === options.slug || m.defaultPort === port || m.id === tokens.ID,
  );
  if (clash) usage(`${clash.id} already uses that number, slug or port`);

  const out = values.out ? resolve(values.out) : join(ROOT, 'modules', tokens.ID);
  const written = scaffold(options, out);
  console.log(`created ${relative(process.cwd(), out) || '.'} (${written.length} files)`);

  if (values.register) {
    register(options);
    console.log('registered in modules/registry.json and src/data/modules.ts');
  }

  console.log(`
Next:
  1. cd ${relative(process.cwd(), out)} && npm install && npm test      (build platform/clients first)
  2. Replace the example domain: server/items.ts, server/db.ts, shared/types.ts,
     the routes in server/app.ts, src/components/ItemsView.tsx, test/api.test.ts.
  3. Decide who may do what: server/access.ts (see docs/ACCESS-LEVELS.md).
  4. Write the README: the invariants, the out-of-scope list, the API.${
    values.register
      ? ''
      : '\n  5. Register it: re-run with --register, or add the registry entry and the\n     copy block in src/data/modules.ts by hand (docs/PROVISIONING.md).'
  }
  Before CI is green, also: translate the catalogue copy (src/i18n) and give it
  a one-line task in src/components/Platform.astro (the site build refuses
  without one), list it in modules/README.md, raise the module counts the
  deploy suite pins on purpose (deploy/test/registry.test.ts, backup.test.ts),
  and add it to the shells' catalogues (MOD-15, MOD-16) if it should appear on
  a board. \`cd deploy && npx vitest run\` says what is still missing; \`npm run
  build\` at the root checks the site.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
