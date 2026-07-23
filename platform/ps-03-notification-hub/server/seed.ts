import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';

/**
 * Idempotent demo data: one channel per type (all on the console provider,
 * so zero external calls), a few templates including one with two versions,
 * and messages across every status. Re-running is a no-op once any channel
 * exists.
 */
export function seed(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number };
  if (existing.n > 0) return;

  const now = Date.now();
  const at = nowIso(now);

  db.transaction(() => {
    const channel = (type: string, name: string, provider = 'console', config = '{}'): number => {
      const info = db
        .prepare('INSERT INTO channels (type, name, provider, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(type, name, provider, config, at);
      return Number(info.lastInsertRowid);
    };
    const emailId = channel('email', 'transactional-email', 'resend-email', JSON.stringify({ from: 'notify@example.com' }));
    channel('sms', 'sms-default');
    channel('push', 'push-default');
    channel('slack', 'slack-ops', 'webhook', JSON.stringify({ url: 'https://hooks.slack.invalid/xxx' }));
    channel('teams', 'teams-ops');
    channel('discord', 'discord-community');
    channel('webhook', 'generic-webhook', 'webhook', JSON.stringify({ url: 'https://example.invalid/hook' }));

    const template = (key: string, version: number, channelType: string, subject: string | null, bodyText: string): void => {
      db.prepare(
        'INSERT INTO templates (key, version, channel_type, locale, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(key, version, channelType, 'en', subject, bodyText, at);
    };
    template('welcome-email', 1, 'email', 'Welcome, {{name}}', '<p>Hi {{name}}, welcome to {{org}}.</p>');
    template('welcome-email', 2, 'email', 'Welcome aboard, {{name}}', '<p>Hi {{name}}, welcome to {{org}}!</p>');
    template('ticket-updated', 1, 'email', 'Ticket {{ref}} updated', 'Your ticket {{ref}} is now {{status}}.');
    template('password-reset', 1, 'email', 'Reset your password', 'Use this link: {{link}}');

    const message = (status: string, subject: string, bodyText: string): void => {
      db.prepare(
        `INSERT INTO messages
           (channel_id, template_key, to_address, subject, body, variables, status, attempts,
            next_attempt_at, last_error, provider_message_id, created_at, updated_at, sent_at)
         VALUES (?, 'welcome-email', 'user@example.com', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        emailId,
        subject,
        bodyText,
        status,
        status === 'queued' ? 0 : status === 'sent' ? 1 : 3,
        at,
        status === 'dead' ? 'HTTP 500' : null,
        status === 'sent' ? 'console-seed' : null,
        at,
        at,
        status === 'sent' ? at : null,
      );
    };
    message('queued', 'Welcome, Ada', '<p>Hi Ada</p>');
    message('sent', 'Welcome, Ben', '<p>Hi Ben</p>');
    message('failed', 'Welcome, Cara', '<p>Hi Cara</p>');
    message('dead', 'Welcome, Dan', '<p>Hi Dan</p>');
  })();

  console.log('[seed] inserted 7 channels, 4 templates (one with 2 versions), 4 messages');
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
