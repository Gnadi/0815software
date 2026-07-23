import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { ingestDocument } from './rag.js';
import type { ChatMessage } from '../shared/types.js';

/**
 * Idempotent demo data: two prompts (each with two versions and an active
 * pointer), a small RAG collection embedded via the mock model, and a
 * couple of logged completions. Re-running is a no-op once any prompt
 * exists.
 */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM prompts').get() as { n: number };
  if (existing.n > 0) return;

  const now = Date.now();
  const at = nowIso(now);

  const addPrompt = (key: string, name: string, versions: ChatMessage[][], active: number): void => {
    const info = db
      .prepare('INSERT INTO prompts (key, name, active_version, created_at) VALUES (?, ?, ?, ?)')
      .run(key, name, active, at);
    const promptId = Number(info.lastInsertRowid);
    versions.forEach((template, i) => {
      db.prepare('INSERT INTO prompt_versions (prompt_id, version, template, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(
        promptId,
        i + 1,
        JSON.stringify(template),
        `v${i + 1}`,
        at,
      );
    });
  };

  db.transaction(() => {
    addPrompt(
      'summarize',
      'Summarize text',
      [
        [
          { role: 'system', content: 'You summarize text.' },
          { role: 'user', content: 'Summarize: {{text}}' },
        ],
        [
          { role: 'system', content: 'You are a concise summarizer. Answer in one sentence.' },
          { role: 'user', content: 'Summarize the following:\n\n{{text}}' },
        ],
      ],
      2,
    );
    addPrompt(
      'classify-intent',
      'Classify intent',
      [
        [{ role: 'user', content: 'Classify the intent of: {{message}}' }],
        [
          { role: 'system', content: 'Classify the user message into one of: question, complaint, request.' },
          { role: 'user', content: '{{message}}' },
        ],
      ],
      1,
    );
  })();

  // A small knowledge collection, embedded through the mock model.
  const docs = [
    'Platform Services are shared backend capabilities consumed by modules over APIs.',
    'Business Modules are complete customer-facing applications.',
    'PS-04 provides chat, embeddings, RAG and prompt management.',
    'The mock provider is deterministic and makes zero external calls.',
  ];
  for (const text of docs) ingestDocument(db, 'handbook', text, now);

  console.log('[seed] inserted 2 prompts (2 versions each), a RAG collection, embeddings');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
