/**
 * Regenerate the ebInterface golden files from test/ebinterface-cases.ts.
 *
 *   npm run ebinterface:fixtures   → test/fixtures/ebinterface/*.xml
 *
 * Commit them only after `npm test` has validated them against the official
 * ebInterface 6.1 schema (test/ebinterface.test.ts) — see docs/E-RECHNUNG.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEbInterface } from '../shared/ebinterface.js';
import { AT_CASES } from '../test/ebinterface-cases.js';

const out = join(import.meta.dirname, '..', 'test', 'fixtures', 'ebinterface');
mkdirSync(out, { recursive: true });
for (const [name, model] of Object.entries(AT_CASES)) writeFileSync(join(out, `${name}.xml`), renderEbInterface(model));
console.log(`wrote ${Object.keys(AT_CASES).length} cases to ${out}`);
