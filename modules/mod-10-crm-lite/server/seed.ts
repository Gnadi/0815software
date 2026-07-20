import type Database from 'better-sqlite3';
import { createCompany } from './companies.js';
import { createContact } from './contacts.js';
import { createDeal, moveStage, reopenDeal } from './deals.js';
import { createActivity, setFollowUpDone } from './activities.js';
import type { ActivityType } from '../shared/types.js';

/**
 * Example dataset: 5 companies, 15 contacts, 12 deals spread across every
 * pipeline stage (including won and lost) with realistic multi-move
 * stage histories — one of them reopened from lost — and ~30 activities
 * including a handful of open and overdue follow-ups.
 *
 * Everything goes THROUGH the domain functions (createDeal → moveStage /
 * reopenDeal, createActivity → setFollowUpDone), so the seeded database
 * satisfies the same invariants as a live one: append-only stage history
 * with deals.stage always equal to the latest event, append-only
 * activity log, and no stored derived state.
 *
 * Idempotent: if any companies exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM companies').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} companies, skipping`);
    return;
  }

  db.transaction(() => {
    // ── Companies ──────────────────────────────────────────────────────
    const helios = createCompany(db, {
      name: 'Helios Renewables GmbH',
      domain: 'helios-energy.example.at',
      notes: 'Solar and storage integrator; multi-site framework in progress.',
      createdAt: '2026-01-08T09:00:00Z',
    });
    const marlow = createCompany(db, {
      name: 'Marlow Logistics AG',
      domain: 'marlow-logistics.example.com',
      notes: 'Regional freight and warehousing; price-sensitive.',
      createdAt: '2026-01-12T09:00:00Z',
    });
    const brenner = createCompany(db, {
      name: 'Brenner Baustoffe e.U.',
      domain: 'brenner-baustoffe.example.at',
      notes: null,
      createdAt: '2026-02-03T09:00:00Z',
    });
    const alpine = createCompany(db, {
      name: 'Alpine Data Systems',
      domain: 'alpinedata.example.io',
      notes: 'Managed hosting; technical buyer, fast cycles.',
      createdAt: '2026-02-20T09:00:00Z',
    });
    const kuechen = createCompany(db, {
      name: 'Küchen Direkt Handels GmbH',
      domain: 'kuechen-direkt.example.at',
      notes: 'Retail chain; seasonal budgets.',
      createdAt: '2026-03-01T09:00:00Z',
    });

    // ── Contacts (3 per company) ───────────────────────────────────────
    const C = (
      name: string,
      email: string | null,
      phone: string | null,
      title: string | null,
      companyId: number,
      createdAt: string,
    ): number => createContact(db, { name, email, phone, title, companyId, createdAt });

    const heliosCTO = C('Ingrid Sauer', 'i.sauer@helios-energy.example.at', '+43 1 2340010', 'CTO', helios, '2026-01-08T10:00:00Z');
    C('Petra Lang', 'p.lang@helios-energy.example.at', '+43 1 2340011', 'Procurement Lead', helios, '2026-01-08T10:05:00Z');
    C('Milan Horvat', 'm.horvat@helios-energy.example.at', null, 'Project Engineer', helios, '2026-01-08T10:10:00Z');

    const marlowCOO = C('Robert Marlow', 'r.marlow@marlow-logistics.example.com', '+43 662 550020', 'COO', marlow, '2026-01-12T10:00:00Z');
    C('Sabine Fischer', 's.fischer@marlow-logistics.example.com', '+43 662 550021', 'Fleet Manager', marlow, '2026-01-12T10:05:00Z');
    C('Tomáš Novotný', 't.novotny@marlow-logistics.example.com', null, 'IT Coordinator', marlow, '2026-01-12T10:10:00Z');

    const brennerOwner = C('Georg Brenner', 'g.brenner@brenner-baustoffe.example.at', '+43 512 660030', 'Owner', brenner, '2026-02-03T10:00:00Z');
    C('Anna Steinbach', 'a.steinbach@brenner-baustoffe.example.at', '+43 512 660031', 'Office Manager', brenner, '2026-02-03T10:05:00Z');
    C('Lukas Mayr', null, '+43 512 660032', 'Warehouse Lead', brenner, '2026-02-03T10:10:00Z');

    const alpineHead = C('Dr. Eva Reinhardt', 'e.reinhardt@alpinedata.example.io', '+43 316 770040', 'Head of Infrastructure', alpine, '2026-02-20T10:00:00Z');
    C('Jonas Wolf', 'j.wolf@alpinedata.example.io', null, 'DevOps Engineer', alpine, '2026-02-20T10:05:00Z');
    C('Clara Berger', 'c.berger@alpinedata.example.io', '+43 316 770042', 'Finance', alpine, '2026-02-20T10:10:00Z');

    const kuechenMD = C('Wolfgang Gruber', 'w.gruber@kuechen-direkt.example.at', '+43 732 880050', 'Managing Director', kuechen, '2026-03-01T10:00:00Z');
    C('Melanie Huber', 'm.huber@kuechen-direkt.example.at', '+43 732 880051', 'Buyer', kuechen, '2026-03-01T10:05:00Z');
    C('Stefan Koch', null, '+43 732 880052', 'Store Operations', kuechen, '2026-03-01T10:10:00Z');

    // ── Deals ──────────────────────────────────────────────────────────
    // Helper: create a deal at `lead`, then walk it through `path` (each
    // step = [toStage, atISO, note?]). The last step's timestamp is the
    // close date for won/lost deals — the win-rate metric reads it.
    const deal = (
      title: string,
      companyId: number,
      contactId: number | null,
      valueCents: number,
      createdAt: string,
      path: [string, string, string?][],
    ): number => {
      const id = createDeal(db, {
        title,
        companyId,
        primaryContactId: contactId,
        valueCents,
        note: null,
        createdAt,
      });
      for (const [to, at, note] of path) {
        moveStage(db, id, to, note ?? null, at);
      }
      return id;
    };

    // lead ×2
    const d1 = deal('Rooftop PV — Phase 1', helios, heliosCTO, 500_000_00, '2026-07-05T09:00:00Z', []);
    deal('Warehouse lighting retrofit', marlow, marlowCOO, 250_000_00, '2026-07-08T09:00:00Z', []);

    // qualified ×2
    const d3 = deal('Battery storage pilot', helios, heliosCTO, 1_200_000_00, '2026-06-10T09:00:00Z', [
      ['qualified', '2026-06-18T09:00:00Z', 'Site survey completed, budget confirmed.'],
    ]);
    deal('Depot solar carport', marlow, marlowCOO, 800_000_00, '2026-06-15T09:00:00Z', [
      ['qualified', '2026-06-22T09:00:00Z'],
    ]);

    // proposal ×2
    deal('Managed hosting migration', alpine, alpineHead, 3_000_000_00, '2026-05-20T09:00:00Z', [
      ['qualified', '2026-05-28T09:00:00Z'],
      ['proposal', '2026-06-05T09:00:00Z', 'Proposal v2 sent.'],
    ]);
    deal('Cabling for new aisle', brenner, brennerOwner, 450_000_00, '2026-06-01T09:00:00Z', [
      ['qualified', '2026-06-09T09:00:00Z'],
      ['proposal', '2026-06-20T09:00:00Z'],
    ]);

    // negotiation ×2 (one of them reopened from lost)
    deal('Data-centre expansion', alpine, alpineHead, 6_000_000_00, '2026-04-15T09:00:00Z', [
      ['qualified', '2026-04-25T09:00:00Z'],
      ['proposal', '2026-05-10T09:00:00Z'],
      ['negotiation', '2026-06-01T09:00:00Z', 'Final pricing round.'],
    ]);
    // Kitchen chain deal: lost, then reopened to negotiation.
    const d8 = createDeal(db, {
      title: 'Store fit-out — appliances',
      companyId: kuechen,
      primaryContactId: kuechenMD,
      valueCents: 1_500_000_00,
      note: 'Revived after budget was re-approved.',
      createdAt: '2026-03-20T09:00:00Z',
    });
    moveStage(db, d8, 'qualified', null, '2026-03-28T09:00:00Z');
    moveStage(db, d8, 'proposal', null, '2026-04-10T09:00:00Z');
    moveStage(db, d8, 'lost', 'Budget frozen for Q2.', '2026-04-20T09:00:00Z');
    reopenDeal(db, d8, 'negotiation', 'Budget re-approved — back in play.', '2026-06-25T09:00:00Z');

    // won ×2 (close dates drive the win-rate metric)
    deal('Annual PV maintenance contract', helios, heliosCTO, 2_000_000_00, '2026-04-01T09:00:00Z', [
      ['qualified', '2026-04-08T09:00:00Z'],
      ['proposal', '2026-04-20T09:00:00Z'],
      ['negotiation', '2026-05-05T09:00:00Z'],
      ['won', '2026-05-20T09:00:00Z', 'Signed 3-year contract.'],
    ]);
    deal('Backup power for cold store', marlow, marlowCOO, 900_000_00, '2026-05-01T09:00:00Z', [
      ['qualified', '2026-05-08T09:00:00Z'],
      ['proposal', '2026-05-20T09:00:00Z'],
      ['negotiation', '2026-06-02T09:00:00Z'],
      ['won', '2026-06-15T09:00:00Z', 'Purchase order received.'],
    ]);

    // lost ×2
    deal('Office HVAC upgrade', brenner, brennerOwner, 1_100_000_00, '2026-05-10T09:00:00Z', [
      ['qualified', '2026-05-18T09:00:00Z'],
      ['proposal', '2026-06-05T09:00:00Z'],
      ['lost', '2026-06-28T09:00:00Z', 'Went with incumbent supplier.'],
    ]);
    const d12 = deal('Showroom lighting', kuechen, kuechenMD, 400_000_00, '2026-06-01T09:00:00Z', [
      ['qualified', '2026-06-10T09:00:00Z'],
      ['lost', '2026-07-10T09:00:00Z', 'Project shelved.'],
    ]);

    // ── Activities & follow-ups ────────────────────────────────────────
    const A = (
      type: ActivityType,
      subject: string,
      body: string | null,
      opts: { contactId?: number; dealId?: number; dueDate?: string; createdAt: string },
    ): number =>
      createActivity(db, {
        type,
        subject,
        body,
        contactId: opts.contactId ?? null,
        dealId: opts.dealId ?? null,
        dueDate: opts.dueDate ?? null,
        createdAt: opts.createdAt,
      });

    // Deal timelines
    A('call', 'Intro call', 'Discussed scope and rough budget.', { contactId: heliosCTO, dealId: d1, createdAt: '2026-07-05T10:00:00Z' });
    A('email', 'Sent capability overview', null, { contactId: heliosCTO, dealId: d1, createdAt: '2026-07-06T11:30:00Z' });
    A('meeting', 'Site walkthrough', 'Reviewed roof structure and access.', { contactId: heliosCTO, dealId: d3, createdAt: '2026-06-17T14:00:00Z' });
    A('note', 'Budget confirmed', 'CFO signed off on the pilot budget.', { dealId: d3, createdAt: '2026-06-18T09:30:00Z' });
    A('call', 'Pricing discussion', null, { contactId: alpineHead, dealId: d8, createdAt: '2026-06-25T10:00:00Z' });
    A('email', 'Revised quote sent', 'Adjusted appliance package pricing.', { contactId: kuechenMD, dealId: d8, createdAt: '2026-06-26T09:00:00Z' });
    A('note', 'Lost to incumbent', 'They matched our price on service.', { dealId: d12, createdAt: '2026-07-10T09:15:00Z' });

    // Contact-only touches
    A('email', 'Quarterly check-in', null, { contactId: marlowCOO, createdAt: '2026-07-01T09:00:00Z' });
    A('call', 'Referral introduction', 'Introduced by Brenner.', { contactId: alpineHead, createdAt: '2026-06-30T15:00:00Z' });
    A('note', 'Prefers email over calls', null, { contactId: brennerOwner, createdAt: '2026-06-12T08:00:00Z' });

    // ── Follow-ups ─────────────────────────────────────────────────────
    // Overdue (due before today = 2026-07-19), still open.
    A('call', 'Follow up on Phase 1 proposal', 'Chase decision on rooftop PV.', { contactId: heliosCTO, dealId: d1, dueDate: '2026-07-10', createdAt: '2026-07-06T12:00:00Z' });
    A('email', 'Send storage references', null, { contactId: heliosCTO, dealId: d3, dueDate: '2026-07-15', createdAt: '2026-07-08T09:00:00Z' });
    A('meeting', 'Book negotiation call', null, { contactId: kuechenMD, dealId: d8, dueDate: '2026-07-17', createdAt: '2026-06-27T09:00:00Z' });

    // Open, due today or in the future.
    A('call', 'Confirm carport site access', null, { contactId: marlowCOO, dueDate: '2026-07-19', createdAt: '2026-07-12T09:00:00Z' });
    A('email', 'Send hosting migration SOW', null, { contactId: alpineHead, dueDate: '2026-07-22', createdAt: '2026-07-14T09:00:00Z' });
    A('meeting', 'Quarterly business review', null, { contactId: marlowCOO, dueDate: '2026-08-01', createdAt: '2026-07-15T09:00:00Z' });

    // A follow-up already completed (recorded via done_at).
    const doneFollowUp = A('call', 'Chase signed maintenance contract', null, { contactId: heliosCTO, dueDate: '2026-05-18', createdAt: '2026-05-12T09:00:00Z' });
    setFollowUpDone(db, doneFollowUp, true, '2026-05-19T16:00:00Z');
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM companies) AS companies,
              (SELECT COUNT(*) FROM contacts) AS contacts,
              (SELECT COUNT(*) FROM deals) AS deals,
              (SELECT COUNT(*) FROM deal_stage_events) AS events,
              (SELECT COUNT(*) FROM activities) AS activities`,
    )
    .get() as { companies: number; contacts: number; deals: number; events: number; activities: number };
  console.log(
    `[seed] inserted ${stats.companies} companies, ${stats.contacts} contacts, ${stats.deals} deals, ${stats.events} stage events, ${stats.activities} activities`,
  );
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
