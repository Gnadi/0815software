import type Database from 'better-sqlite3';
import { claimRecipient, readExpenseSettings } from './expenses.js';
import type { PlatformHooks } from './platform.js';

/**
 * What the expense routes ask of the Platform Services: mail through PS-03,
 * opt-in — with NOTIFICATION_URL unset nothing leaves the module. Receipts
 * are read from their till code or typed, never sent to a model: a receipt
 * photo stays here, as the receipt.
 */

export const fmtEuro = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

/** Best-effort: a mail that does not go out never undoes the decision. */
export async function sendExpenseMail(db: Database.Database, platform: PlatformHooks, to: string, subject: string, text: string, key: string): Promise<void> {
  if (!platform.notificationConfigured || !platform.notify) return;
  try {
    await platform.notify({ channel: readExpenseSettings(db).channel, to, subject, body: text, idempotencyKey: key });
  } catch (err) {
    console.warn('[mod-11] expense notification failed:', err);
  }
}

export async function tellEmployee(db: Database.Database, platform: PlatformHooks, claimId: number, step: 'approved' | 'rejected' | 'paid'): Promise<void> {
  if (!readExpenseSettings(db).notify_employee) return;
  const r = claimRecipient(db, claimId);
  if (!r.email) return;
  const subject =
    step === 'approved' ? `Your expense claim ${r.number} is approved` : step === 'rejected' ? `Your expense claim ${r.number} was returned` : `Your expense claim ${r.number} is paid`;
  const text =
    step === 'approved'
      ? `Hello ${r.name},\n\nyour claim "${r.title}" (${fmtEuro(r.total_cents)}) is approved and will be paid out.`
      : step === 'rejected'
        ? `Hello ${r.name},\n\nyour claim "${r.title}" (${fmtEuro(r.total_cents)}) was returned: ${r.note ?? ''}\n\nIts items are free again — correct them and submit them anew.`
        : `Hello ${r.name},\n\nyour claim "${r.title}" (${fmtEuro(r.total_cents)}) is paid.`;
  await sendExpenseMail(db, platform, r.email, subject, text, `mod-11:expense-claim:${r.number}:${step}`);
}
