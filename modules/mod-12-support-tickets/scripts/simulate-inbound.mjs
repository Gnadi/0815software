#!/usr/bin/env node
/**
 * simulate-inbound.mjs — demonstrate the "email intake" integration point.
 *
 * MOD-12 does not talk to a mailbox. Instead it exposes ONE authenticated
 * endpoint, `POST /api/intake/email`, that accepts an already-parsed email
 * as JSON. Wiring a real inbox to it — an IMAP poller, a Postmark/SendGrid
 * inbound webhook, a Lambda that parses MIME — is the integration point,
 * and is deliberately OUT OF SCOPE (see the README). Whatever bridge you
 * build only has to POST this shape with the shared secret header:
 *
 *   { "from": "...", "subject": "...", "body": "...", "in_reply_to": "TKT-..." }
 *
 * This script POSTs a sample "email" to a running server. Run it twice:
 * once with no --ref to OPEN a new ticket, then again passing that ticket's
 * ref as --ref to APPEND a reply to it (an in-reply-to that matches a
 * non-closed ticket becomes a public comment; anything else opens a new
 * ticket).
 *
 * Usage:
 *   node scripts/simulate-inbound.mjs
 *   node scripts/simulate-inbound.mjs --ref TKT-2026-0021 \
 *        --from someone@example.com --subject "Re: ..." --body "Thanks!"
 *
 * Env: BASE_URL (default http://localhost:3012), INTAKE_SECRET
 *      (default dev-intake-secret — must match the server).
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key) args.set(key, process.argv[i + 1]);
}

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3012';
const secret = process.env.INTAKE_SECRET ?? 'dev-intake-secret';

const payload = {
  from: args.get('from') ?? 'walter.keller@example.com',
  subject: args.get('subject') ?? 'Printer queue stuck again',
  body:
    args.get('body') ??
    'The shared printer queue is stuck once more — nothing prints and the jobs pile up. Sent from my phone.',
};
if (args.get('ref')) payload.in_reply_to = args.get('ref');

const res = await fetch(`${baseUrl}/api/intake/email`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Intake-Secret': secret,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = text;
}

if (!res.ok) {
  console.error(`Intake failed (${res.status}):`, parsed);
  process.exit(1);
}

console.log(`Intake OK (${res.status}):`, parsed);
if (parsed.action === 'created') {
  console.log(`\nOpened new ticket ${parsed.ref}. Re-run with --ref ${parsed.ref} to append a reply.`);
} else if (parsed.action === 'appended') {
  console.log(`\nAppended a public reply to ${parsed.ref}.`);
}
