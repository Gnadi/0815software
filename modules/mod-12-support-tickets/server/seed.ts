import type Database from 'better-sqlite3';
import type { CommentVisibility, Priority, Status } from '../shared/types.js';
import {
  addComment,
  assignTicket,
  changePriority,
  changeStatus,
  createTicket,
  nowIso,
} from './tickets.js';

/**
 * Example dataset: 5 agents and 15 tickets across every status and every
 * priority, with realistic append-only timelines — assignments and
 * reassignments, public replies, internal notes, one requester follow-up
 * that reopens a resolved ticket, and both web- and email-channel intake.
 *
 * Everything goes THROUGH the domain functions (createTicket →
 * assign/changeStatus/changePriority/addComment), so the seeded database
 * satisfies the same invariants as a live one: append-only events, no
 * stored derived state, legal transitions only.
 *
 * RELATIVE TIMESTAMPS. Every event time is expressed as "minutes ago"
 * from the moment the seed runs, so the derived SLA breach states are
 * stable no matter when you seed: the urgent ticket that has been sitting
 * unanswered for 95 minutes is always past its 30-minute first-response
 * target, the low-priority queue always has an in-progress resolution
 * breach, one ticket is always in the at-risk window, and so on.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any agents already exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} agents, skipping`);
    return;
  }

  const base = Date.now();
  /** ISO timestamp for `m` minutes before the seed moment. */
  const ago = (m: number): string => nowIso(base - m * 60_000);

  db.transaction(() => {
    // ── Agents ─────────────────────────────────────────────────────────
    const insertAgent = db.prepare(
      'INSERT INTO agents (name, email, created_at) VALUES (?, ?, ?)',
    );
    const agentDefs: [string, string][] = [
      ['Mara Ellison', 'mara@desk.example.com'],
      ['Tobias Reinhardt', 'tobias@desk.example.com'],
      ['Priya Nayar', 'priya@desk.example.com'],
      ['Sven Larsson', 'sven@desk.example.com'],
      ['Yuki Tanaka', 'yuki@desk.example.com'],
    ];
    const agentId: Record<string, number> = {};
    for (const [name, email] of agentDefs) {
      const info = insertAgent.run(name, email, ago(60 * 24 * 30));
      agentId[name] = Number(info.lastInsertRowid);
    }
    const agentName = Object.fromEntries(
      Object.entries(agentId).map(([name, id]) => [id, name]),
    ) as Record<number, string>;

    // ── Timeline driver ────────────────────────────────────────────────
    type Step =
      | { do: 'assign'; agent: number | null; at: number }
      | { do: 'status'; to: Status; at: number }
      | { do: 'priority'; to: Priority; at: number }
      | { do: 'reply'; agent: number; body: string; at: number }
      | { do: 'note'; agent: number; body: string; at: number }
      | { do: 'follow-up'; body: string; at: number };

    interface TicketSpec {
      name: string;
      email: string;
      subject: string;
      body: string;
      priority: Priority;
      channel: 'web' | 'email';
      created: number; // minutes ago
      steps: Step[];
    }

    const run = (spec: TicketSpec): void => {
      const ref = createTicket(db, {
        requesterName: spec.name,
        requesterEmail: spec.email,
        subject: spec.subject,
        body: spec.body,
        priority: spec.priority,
        channel: spec.channel,
        actor: spec.email,
        actorType: 'requester',
        at: ago(spec.created),
      });
      for (const step of spec.steps) {
        switch (step.do) {
          case 'assign':
            assignTicket(db, ref, step.agent, step.agent ? agentName[step.agent]! : 'triage', ago(step.at));
            break;
          case 'status':
            changeStatus(db, ref, step.to, 'agent', 'agent', ago(step.at));
            break;
          case 'priority':
            changePriority(db, ref, step.to, 'agent', ago(step.at));
            break;
          case 'reply':
            addComment(db, ref, {
              body: step.body,
              visibility: 'public' as CommentVisibility,
              actor: agentName[step.agent]!,
              actorType: 'agent',
              at: ago(step.at),
            });
            break;
          case 'note':
            addComment(db, ref, {
              body: step.body,
              visibility: 'internal' as CommentVisibility,
              actor: agentName[step.agent]!,
              actorType: 'agent',
              at: ago(step.at),
            });
            break;
          case 'follow-up':
            addComment(db, ref, {
              body: step.body,
              visibility: 'public' as CommentVisibility,
              actor: spec.email,
              actorType: 'requester',
              at: ago(step.at),
            });
            break;
        }
      }
    };

    const MARA = agentId['Mara Ellison']!;
    const TOBIAS = agentId['Tobias Reinhardt']!;
    const PRIYA = agentId['Priya Nayar']!;
    const SVEN = agentId['Sven Larsson']!;
    const YUKI = agentId['Yuki Tanaka']!;

    // T1 — urgent, NEW, unassigned, first-response BREACHED (email intake).
    run({
      name: 'lena.brandt@northwind.example.com',
      email: 'lena.brandt@northwind.example.com',
      subject: 'Checkout returns 500 for all customers',
      body: 'Since ~08:00 every checkout attempt fails with a 500. This is blocking all orders.',
      priority: 'urgent',
      channel: 'email',
      created: 95,
      steps: [],
    });

    // T2 — high, OPEN, assigned, first response met, within SLA.
    run({
      name: 'Ravi Menon',
      email: 'ravi.menon@company.example.com',
      subject: 'SSO login loops back to the sign-in page',
      body: 'After entering credentials I am redirected back to the login page. Chrome and Firefox both.',
      priority: 'high',
      channel: 'web',
      created: 300,
      steps: [
        { do: 'assign', agent: MARA, at: 296 },
        { do: 'status', to: 'open', at: 296 },
        { do: 'reply', agent: MARA, body: 'Thanks Ravi — reproduced. Clearing the stale SAML session cookie; can you retry?', at: 280 },
      ],
    });

    // T3 — normal, PENDING (waiting on requester), within SLA.
    run({
      name: 'Chloé Fontaine',
      email: 'chloe@studiofontaine.example.com',
      subject: 'Export to CSV drops the last column',
      body: 'The CSV export is missing the "Notes" column that shows on screen.',
      priority: 'normal',
      channel: 'web',
      created: 600,
      steps: [
        { do: 'assign', agent: TOBIAS, at: 595 },
        { do: 'status', to: 'open', at: 595 },
        { do: 'reply', agent: TOBIAS, body: 'Which export button are you using — the toolbar one or the row menu? A screenshot would help.', at: 560 },
        { do: 'status', to: 'pending', at: 559 },
      ],
    });

    // T4 — normal, RESOLVED, resolution met.
    run({
      name: 'Daniel Ostrowski',
      email: 'd.ostrowski@meridian.example.com',
      subject: 'Invoice PDF shows the wrong VAT rate',
      body: 'Invoices are rendering 19% VAT but our account is set to 20%.',
      priority: 'normal',
      channel: 'email',
      created: 1000,
      steps: [
        { do: 'assign', agent: PRIYA, at: 995 },
        { do: 'status', to: 'open', at: 995 },
        { do: 'reply', agent: PRIYA, body: 'Confirmed a stale tax profile on your account. Corrected and regenerated the affected invoices.', at: 980 },
        { do: 'status', to: 'resolved', at: 900 },
      ],
    });

    // T5 — low, CLOSED, the full happy path (all SLAs met).
    run({
      name: 'Amara Okonkwo',
      email: 'amara@brightpath.example.com',
      subject: 'Add my colleague as a read-only user',
      body: 'Please add jback@brightpath.example.com with view-only access to the dashboards.',
      priority: 'low',
      channel: 'web',
      created: 5000,
      steps: [
        { do: 'assign', agent: SVEN, at: 4980 },
        { do: 'status', to: 'open', at: 4980 },
        { do: 'reply', agent: SVEN, body: 'Done — invite sent to jback@brightpath.example.com with the Viewer role.', at: 4900 },
        { do: 'status', to: 'resolved', at: 4800 },
        { do: 'status', to: 'closed', at: 4300 },
      ],
    });

    // T6 — urgent, RESOLVED but resolution BREACHED (resolved late).
    run({
      name: 'Felix Wagner',
      email: 'felix.wagner@atlas.example.com',
      subject: 'Payment webhook stopped firing overnight',
      body: 'No payment webhooks received since midnight; reconciliation is stuck.',
      priority: 'urgent',
      channel: 'email',
      created: 400,
      steps: [
        { do: 'assign', agent: MARA, at: 396 },
        { do: 'status', to: 'open', at: 396 },
        { do: 'reply', agent: MARA, body: 'On it — the webhook worker had crashed. Restarted and replaying the backlog now.', at: 380 },
        { do: 'note', agent: MARA, body: 'Root cause: OOM on the worker after the 3.4 deploy. Ticket open for a memory-limit bump.', at: 300 },
        { do: 'status', to: 'resolved', at: 100 },
      ],
    });

    // T7 — high, OPEN, resolution BREACH in progress (assigned, no fix yet).
    run({
      name: 'Sofia Marchetti',
      email: 'sofia@marchetti-consulting.example.com',
      subject: 'Reports dashboard extremely slow (30s+)',
      body: 'The reports dashboard takes over 30 seconds to load since Monday.',
      priority: 'high',
      channel: 'web',
      created: 600,
      steps: [
        { do: 'assign', agent: PRIYA, at: 590 },
        { do: 'status', to: 'open', at: 590 },
        { do: 'reply', agent: PRIYA, body: 'Thanks — we can see the slow query in traces and are adding an index. Will update shortly.', at: 580 },
        { do: 'note', agent: PRIYA, body: 'Missing index on events(created_at). Migration drafted, waiting on a maintenance window.', at: 400 },
      ],
    });

    // T8 — normal, OPEN, first response AT RISK (assigned, no reply yet).
    run({
      name: 'Henrik Bauer',
      email: 'henrik.bauer@volt.example.com',
      subject: 'Cannot upload attachments over 2 MB',
      body: 'Uploading a 3 MB PDF fails with "file too large" although the limit should be 10 MB.',
      priority: 'normal',
      channel: 'web',
      created: 200,
      steps: [
        { do: 'assign', agent: TOBIAS, at: 30 },
        { do: 'status', to: 'open', at: 30 },
      ],
    });

    // T9 — low, NEW, unassigned, comfortably within SLA.
    run({
      name: 'Grace Liang',
      email: 'grace.liang@harbor.example.com',
      subject: 'Feature request: dark mode for the portal',
      body: 'Would love a dark theme for the customer portal — the white screen is harsh at night.',
      priority: 'low',
      channel: 'web',
      created: 60,
      steps: [],
    });

    // T10 — normal, REOPENED by a requester follow-up on a resolved ticket.
    run({
      name: 'Marco Silva',
      email: 'marco.silva@delta.example.com',
      subject: 'Two-factor codes arrive several minutes late',
      body: 'SMS 2FA codes arrive 3–5 minutes late, often after they have expired.',
      priority: 'normal',
      channel: 'email',
      created: 2000,
      steps: [
        { do: 'assign', agent: YUKI, at: 1990 },
        { do: 'status', to: 'open', at: 1990 },
        { do: 'reply', agent: YUKI, body: 'We switched SMS providers for your region; delivery should be under 10s now. Please confirm.', at: 1960 },
        { do: 'status', to: 'resolved', at: 1800 },
        { do: 'follow-up', body: 'Better, but it happened again twice this morning. Re-opening.', at: 50 },
      ],
    });

    // T11 — high, CLOSED, all SLAs met.
    run({
      name: 'Elena Popescu',
      email: 'elena.popescu@nexus.example.com',
      subject: 'API key rotated but old key still works',
      body: 'I rotated our API key yesterday but the previous key is still accepted.',
      priority: 'high',
      channel: 'web',
      created: 4000,
      steps: [
        { do: 'assign', agent: SVEN, at: 3990 },
        { do: 'status', to: 'open', at: 3990 },
        { do: 'reply', agent: SVEN, body: 'Old keys had a 24h grace window by design — now revoked immediately on your account.', at: 3970 },
        { do: 'status', to: 'resolved', at: 3600 },
        { do: 'status', to: 'closed', at: 3000 },
      ],
    });

    // T12 — urgent, PENDING, assigned, first response met.
    run({
      name: 'Jonas Meyer',
      email: 'jonas.meyer@orbit.example.com',
      subject: 'Production data export looks truncated',
      body: 'Our nightly export is about half the usual size. Did something change?',
      priority: 'urgent',
      channel: 'email',
      created: 120,
      steps: [
        { do: 'assign', agent: MARA, at: 118 },
        { do: 'status', to: 'open', at: 118 },
        { do: 'reply', agent: MARA, body: 'Looking now. Can you confirm the exact file size and the date of the last good export?', at: 110 },
        { do: 'status', to: 'pending', at: 100 },
      ],
    });

    // T13 — normal, OPEN, reassigned once, with an internal note.
    run({
      name: 'Aisha Rahman',
      email: 'aisha@rahman-legal.example.com',
      subject: 'Search does not match accented characters',
      body: 'Searching for "Muller" does not find "Müller". Diacritics seem to break matching.',
      priority: 'normal',
      channel: 'web',
      created: 800,
      steps: [
        { do: 'assign', agent: TOBIAS, at: 790 },
        { do: 'status', to: 'open', at: 790 },
        { do: 'reply', agent: TOBIAS, body: 'Reproduced. This needs a search-index change — handing to Priya who owns that service.', at: 700 },
        { do: 'note', agent: TOBIAS, body: 'Needs unaccent() on the tsvector column. Out of my area — reassigning.', at: 650 },
        { do: 'assign', agent: PRIYA, at: 600 },
      ],
    });

    // T14 — low, OPEN, unassigned, first-response BREACHED.
    run({
      name: 'Bruno Costa',
      email: 'bruno.costa@lumen.example.com',
      subject: 'Typo on the billing settings page',
      body: 'The billing page says "Recieve invoices" — should be "Receive".',
      priority: 'low',
      channel: 'web',
      created: 600,
      steps: [{ do: 'status', to: 'open', at: 590 }],
    });

    // T15 — high, NEW, email intake, within SLA (just arrived).
    run({
      name: 'Nadia Haddad',
      email: 'nadia.haddad@vertex.example.com',
      subject: 'Webhook signature verification failing after update',
      body: 'After your changelog note about signing, our webhook verification started rejecting payloads.',
      priority: 'high',
      channel: 'email',
      created: 20,
      steps: [],
    });
  })();

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM agents) AS agents,
              (SELECT COUNT(*) FROM tickets) AS tickets,
              (SELECT COUNT(*) FROM ticket_events) AS events`,
    )
    .get() as { agents: number; tickets: number; events: number };
  console.log(
    `[seed] inserted ${stats.agents} agents, ${stats.tickets} tickets, ${stats.events} timeline events`,
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
