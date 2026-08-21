// ─── Module catalogue data ──────────────────────────────────────────────────
// Presentation copy for the catalogue grid (modules.astro), the homepage
// modules section (Modules.astro) and the per-module detail pages
// (modules/[slug].astro).
//
// The STRUCTURAL fields — n, slug, folder, title, scope — come from
// modules/registry.json, the machine-readable source of truth that
// deploy/provision.mjs and the demo hubs also read. Only the copy lives here:
// a short catalogue blurb, a longer overview, a feature list and a `screen`
// spec that the ModuleScreenshot component renders into an on-brand UI mockup.
// Adding a module is therefore a registry entry plus a copy block below; the
// registry drift test (deploy/test/registry.test.ts) fails if the two
// disagree.
import { registryModules, type ModuleRegistryEntry } from '../../modules/registry.ts';

export interface ScreenStat { label: string; value: string; }
export interface ScreenColumn { title: string; cards: string[]; }
export interface ScreenField { label: string; value: string; }

/**
 * One widget on a Workspace board, in the same 12-column grid the real one uses
 * (`mod-15-workspace/shared/types.ts`, GRID_COLUMNS). `source` is the module the
 * figures came from — the label the real widget header carries — because a board
 * that does not say which module each number belongs to is just a dashboard.
 */
export interface ScreenWidget {
  source: string;
  label: string;
  value?: string;
  rows?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Drawn lifted and outlined, the way the real grid previews a drag. */
  dragging?: boolean;
}

/**
 * One pane on a Mosaic board: a whole module in a frame, in the same
 * 12-column grid the real one uses. `rows` are a few lines of that module's own
 * screen — the point of the picture is that these are applications, not
 * summaries, so the miniature has to look like the app.
 */
export interface ScreenPane {
  n: string;
  label: string;
  rows: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ModuleScreen {
  variant: 'table' | 'dashboard' | 'board' | 'detail' | 'catalogue' | 'workspace' | 'mosaic';
  accent: string;
  nav: string[];
  // table
  columns?: string[];
  rows?: string[][];
  statuses?: string[];
  // dashboard
  stats?: ScreenStat[];
  // board
  boardColumns?: ScreenColumn[];
  // detail
  recordTitle?: string;
  fields?: ScreenField[];
  list?: string[];
  // catalogue
  cards?: { title: string; sub: string }[];
  // workspace — a shell that hosts other modules, so it has no sidebar of its
  // own: boards are tabs, and every panel is fed by the module it names.
  boards?: string[];
  contextChip?: string;
  widgets?: ScreenWidget[];
  // mosaic — panes are whole modules, so each one is drawn as a miniature of
  // that module's own UI rather than as a figure.
  panes?: ScreenPane[];
}

/** The copy this file owns, keyed by the registry's module id. */
export interface ModulePresentation {
  body: string;
  overview: string;
  features: string[];
  screen: ModuleScreen;
}

/** A catalogue entry as the pages consume it: registry facts plus copy. */
export interface ModuleEntry extends ModulePresentation {
  n: string;
  slug: string;
  folder: string;
  title: string;
  scope: string;
  source: string;
}

const REPO = 'https://github.com/Gnadi/0815software/tree/main/modules';

const presentation: Record<string, ModulePresentation> = {
  'mod-01-customer-portal': {
    body: 'Self-service access to orders, documents, and status. No account manager required.',
    overview:
      'Customers sign in with email and password and see exactly their own data: an order list with search and status filters, an order detail view with line items and a status timeline, and a document area with authenticated downloads. Strict tenant isolation is the core correctness property — every query is scoped to the signed-in customer, and requesting anyone else’s order or document returns 404, proven by tests.',
    features: [
      'Per-customer order list with search and status filters',
      'Order detail with line items and a placed → confirmed → shipped → delivered timeline',
      'Authenticated document downloads — invoices, delivery notes, statements',
      'Strict tenant isolation enforced on every query',
    ],
    screen: {
      variant: 'detail',
      accent: '#6B8FB5',
      nav: ['Orders', 'Documents', 'Account'],
      recordTitle: 'Order #2041',
      list: ['#2041 · Shipped', '#2038 · Delivered', '#2031 · Confirmed', '#2024 · Placed'],
      fields: [
        { label: 'Status', value: 'Shipped' },
        { label: 'Placed', value: '12 Mar 2026' },
        { label: 'Items', value: '3 line items' },
        { label: 'Total', value: '€ 1,248.00' },
      ],
    },
  },
  'mod-02-admin-dashboard': {
    body: 'Internal CRUD interface over any data model. Tables, filters, bulk actions, exports.',
    overview:
      'The dashboard is config-driven: you describe your data model once, in a single TypeScript file, and the whole application — SQLite schema, REST API, validation, list views, filter row, forms and CSV exports — derives from it. No code generation, no migrations tool, no external services.',
    features: [
      'One TypeScript config drives schema, API, forms and exports',
      'Sortable, filterable tables over any model',
      'Bulk actions and one-click CSV export',
      'Server-side validation derived from the same config',
    ],
    screen: {
      variant: 'table',
      accent: '#7FA88B',
      nav: ['Records', 'Filters', 'Exports', 'Settings'],
      columns: ['ID', 'Name', 'Owner', 'Updated', 'Status'],
      rows: [
        ['#1041', 'Berger Logistik', 'A. Berger', '2h ago', 'Active'],
        ['#1039', 'Steiner & Söhne', 'L. Steiner', '5h ago', 'Active'],
        ['#1034', 'De Vries Handel', 'J. de Vries', '1d ago', 'Paused'],
        ['#1028', 'Nordwind AG', 'K. Meyer', '2d ago', 'Active'],
        ['#1022', 'Ostbahn GmbH', 'P. Klein', '3d ago', 'Archived'],
      ],
      statuses: ['Active', 'Paused', 'Archived'],
    },
  },
  'mod-03-inventory-management': {
    body: 'Stock levels, SKUs, warehouse locations, and purchase order tracking in one place.',
    overview:
      'The core correctness property: stock levels are never stored, they are derived. Every change to inventory — goods in, transfers, stocktake corrections, PO receipts — is an entry in an append-only movements ledger, and the current level of any product in any warehouse is simply the sum of its movements. There is no mutable stock counter that can drift out of sync, and the test suite proves it.',
    features: [
      'Append-only movements ledger — levels are always derived, never stored',
      'SKUs, warehouse locations and per-location stock',
      'Purchase-order tracking with goods-in receipts',
      'Stocktake corrections that reconcile without overwriting history',
    ],
    screen: {
      variant: 'table',
      accent: '#C7A76B',
      nav: ['Products', 'Warehouses', 'Purchase Orders', 'Movements'],
      columns: ['SKU', 'Product', 'Warehouse', 'On hand', 'Status'],
      rows: [
        ['SKU-4401', 'M6 Hex Bolt', 'DE-Nord', '1,240', 'In stock'],
        ['SKU-4390', 'Washer 12mm', 'DE-Nord', '86', 'Low'],
        ['SKU-4372', 'Bracket L', 'AT-Wien', '512', 'In stock'],
        ['SKU-4368', 'Cable 2.5mm', 'NL-West', '0', 'Out'],
        ['SKU-4351', 'Fuse 10A', 'DE-Süd', '340', 'In stock'],
      ],
      statuses: ['In stock', 'Low', 'Out'],
    },
  },
  'mod-04-invoice-billing': {
    body: 'Generate, send, and track invoices — and pay the bills you owe with a SEPA file for your online banking.',
    overview:
      'Totals are never stored, they are derived: an invoice stores line items only — quantity, unit net price in integer cents and VAT rate — and net, VAT-per-rate and gross are always recomputed from the lines. Send invoices, export clean PDFs, track payment status and keep a running customer ledger. The other direction is covered too: record the bills you owe, tick the ones to pay, and download a valid SEPA credit transfer file (ISO 20022 pain.001) to upload in your online banking — with the IBANs check-digit validated, a bill payable only once, and every produced file frozen. With PS-12 Banking wired the same run goes straight to the bank over EBICS instead, though the download never goes away. The test suite proves the arithmetic to the cent.',
    features: [
      'Line-item invoices with per-line VAT rates',
      'Totals recomputed from lines in integer cents — never stored',
      'PDF export and payment-status tracking',
      'Running per-customer ledger',
      'SEPA payment file (pain.001) for paying bills in your online banking',
      'Or send it straight to the bank over EBICS, when PS-12 Banking is wired',
    ],
    screen: {
      variant: 'detail',
      accent: '#C08B8B',
      nav: ['Invoices', 'Customers', 'Bills', 'Ledger'],
      recordTitle: 'Invoice 2026-0148',
      list: ['0148 · Sent', '0147 · Paid', '0146 · Overdue', '0145 · Paid'],
      fields: [
        { label: 'Customer', value: 'Berger Logistik GmbH' },
        { label: 'Net', value: '€ 3,200.00' },
        { label: 'VAT (20%)', value: '€ 640.00' },
        { label: 'Gross', value: '€ 3,840.00' },
      ],
    },
  },
  'mod-05-employee-directory': {
    body: 'Org chart, roles, contact data, and department structure. Integrates with HR onboarding.',
    overview:
      'A searchable directory with roles, contact data and department structure, plus a reporting hierarchy that is provably a forest — every employee has at most one manager, and nobody can manage themselves directly or transitively. The manager graph is validated on every write, and the test suite proves it stays acyclic.',
    features: [
      'Searchable directory of people, roles and departments',
      'Reporting hierarchy proven to be an acyclic forest',
      'Contact data and department structure',
      'Hooks for HR onboarding',
    ],
    screen: {
      variant: 'catalogue',
      accent: '#9B8BB5',
      nav: ['Directory', 'Departments', 'Org chart'],
      cards: [
        { title: 'Anna Berger', sub: 'Head of Ops' },
        { title: 'Lukas Steiner', sub: 'Engineering' },
        { title: 'Jan de Vries', sub: 'Sales' },
        { title: 'Karin Meyer', sub: 'Finance' },
        { title: 'Paul Klein', sub: 'Support' },
        { title: 'Eva Roth', sub: 'People Ops' },
      ],
    },
  },
  'mod-06-procurement-tracker': {
    body: 'RFQ, purchase orders, multi-tier approval workflows. Export to any ERP CSV format.',
    overview:
      'Approval tiers are derived from the order total and frozen at submit: the threshold brackets live in one server config file, and the approval chain a request must clear is computed when it is submitted and never shifts underneath it. Run RFQs, raise purchase orders, route multi-tier approvals and export to any ERP’s CSV format.',
    features: [
      'RFQ → purchase-order workflow',
      'Multi-tier approvals derived from the total, frozen at submit',
      'Threshold brackets in a single server config file',
      'Export to any ERP CSV format',
    ],
    screen: {
      variant: 'table',
      accent: '#6BA5A0',
      nav: ['Requests', 'Approvals', 'Suppliers', 'Export'],
      columns: ['PO', 'Supplier', 'Total', 'Tier', 'Status'],
      rows: [
        ['PO-8841', 'Nordwind AG', '€ 12,400', 'Tier 2', 'Approved'],
        ['PO-8839', 'Ostbahn GmbH', '€ 2,050', 'Tier 1', 'Pending'],
        ['PO-8834', 'Alpin Werk', '€ 48,900', 'Tier 3', 'Pending'],
        ['PO-8828', 'Rhein Metall', '€ 890', 'Tier 1', 'Approved'],
        ['PO-8822', 'Süd Kabel', '€ 6,300', 'Tier 2', 'Rejected'],
      ],
      statuses: ['Approved', 'Pending', 'Rejected'],
    },
  },
  'mod-07-storefront': {
    body: 'Product catalogue, cart, checkout, and order management. No SaaS fees, no revenue cut.',
    overview:
      'One app, two faces on one port: the public shop — no login, no accounts, just an anonymous signed cart cookie and a signed order-lookup link — and the admin, a single staff login for products, categories and orders. No SaaS fees and no cut of your revenue.',
    features: [
      'Public shop with catalogue, cart and checkout — no accounts required',
      'Signed cart cookie and signed order-lookup links',
      'Single-login admin for products, categories and orders',
      'No SaaS fees, no revenue share',
    ],
    screen: {
      variant: 'catalogue',
      accent: '#7FA88B',
      nav: ['Shop', 'Categories', 'Cart', 'Admin'],
      cards: [
        { title: 'Field Jacket', sub: '€ 189.00' },
        { title: 'Wool Scarf', sub: '€ 49.00' },
        { title: 'Canvas Bag', sub: '€ 79.00' },
        { title: 'Leather Belt', sub: '€ 59.00' },
        { title: 'Knit Beanie', sub: '€ 29.00' },
        { title: 'Cotton Tee', sub: '€ 35.00' },
      ],
    },
  },
  'mod-08-reporting-suite': {
    body: 'Scheduled exports, pivot tables, and chart embeds built on top of your existing database.',
    overview:
      'Turn a SQLite database into saved reports, server-computed pivots, hand-rolled SVG charts with signed, session-free embed URLs and scheduled CSV exports — without ever writing to the database it reports on. That read-only guarantee is the core safety property, and the test suite proves it end to end.',
    features: [
      'Saved reports and server-computed pivot tables',
      'Hand-rolled SVG charts with signed, session-free embed URLs',
      'Scheduled CSV exports',
      'Provably read-only against the source database',
    ],
    screen: {
      variant: 'dashboard',
      accent: '#6B8FB5',
      nav: ['Reports', 'Pivots', 'Charts', 'Schedules'],
      stats: [
        { label: 'Revenue MTD', value: '€ 84.2k' },
        { label: 'Orders', value: '1,204' },
        { label: 'Avg. order', value: '€ 69.9' },
        { label: 'Refunds', value: '1.8%' },
      ],
    },
  },
  'mod-09-document-management': {
    body: 'Upload, tag, version, and control access. Matter-based or project-based access controls.',
    overview:
      'Access is matter-based: every document belongs to exactly one matter (or project), and you see a matter only if you have been granted membership on it. Documents carry an append-only version history — every upload adds a new, immutable version with its own SHA-256, size and uploader — with per-matter viewer / editor / owner access levels.',
    features: [
      'Matter- or project-based access control',
      'Append-only version history with per-version SHA-256',
      'Per-matter viewer / editor / owner roles',
      'Tagging and authenticated downloads',
    ],
    screen: {
      variant: 'table',
      accent: '#9B8BB5',
      nav: ['Matters', 'Documents', 'Members', 'Tags'],
      columns: ['Document', 'Matter', 'Version', 'Uploaded', 'Access'],
      rows: [
        ['Contract.pdf', 'M-204 Acquisition', 'v4', 'A. Berger', 'Owner'],
        ['NDA.pdf', 'M-204 Acquisition', 'v1', 'L. Steiner', 'Editor'],
        ['Report.docx', 'M-198 Audit', 'v2', 'K. Meyer', 'Viewer'],
        ['Invoice.pdf', 'M-190 Supply', 'v1', 'J. de Vries', 'Editor'],
        ['Notes.md', 'M-198 Audit', 'v7', 'P. Klein', 'Owner'],
      ],
      statuses: ['Owner', 'Editor', 'Viewer'],
    },
  },
  'mod-10-crm-lite': {
    body: 'Contacts, deals, activity log, and pipeline view. No AI upsells, no seat caps, no surprises.',
    overview:
      'Contacts, companies, deals, an append-only activity log and a config-driven pipeline. No AI, no seat caps, no telemetry, no external calls — the whole app is one Node process and one SQLite file. It never phones home, never counts your users, and has no "contact sales" button.',
    features: [
      'Contacts, companies and deals in a config-driven pipeline',
      'Append-only activity log',
      'One Node process, one SQLite file — no external calls',
      'No AI upsells, no seat caps, no telemetry',
    ],
    screen: {
      variant: 'board',
      accent: '#C7A76B',
      nav: ['Pipeline', 'Contacts', 'Companies', 'Activity'],
      boardColumns: [
        { title: 'Lead', cards: ['Nordwind AG', 'Alpin Werk', 'Süd Kabel'] },
        { title: 'Qualified', cards: ['Ostbahn GmbH', 'Rhein Metall'] },
        { title: 'Proposal', cards: ['Berger Logistik'] },
        { title: 'Won', cards: ['Steiner & Söhne', 'De Vries Handel'] },
      ],
    },
  },
  'mod-11-time-tracking': {
    body: 'Project allocation, daily entry, and export to payroll or billing. Works offline.',
    overview:
      'Project allocation, daily entry, weekly approval and export to payroll or billing. Time is integer minutes; money is derived, never stored — a time entry records a positive integer number of minutes, and cost is always recomputed from the rate. Works offline.',
    features: [
      'Daily entry with project allocation',
      'Weekly approval workflow',
      'Time stored as integer minutes; cost always derived',
      'Export to payroll or billing — works offline',
    ],
    screen: {
      variant: 'table',
      accent: '#6BA5A0',
      nav: ['Timesheet', 'Projects', 'Approvals', 'Export'],
      columns: ['Date', 'Project', 'Task', 'Hours', 'Status'],
      rows: [
        ['Mon 16', 'Website relaunch', 'Frontend', '6.5', 'Approved'],
        ['Tue 17', 'Website relaunch', 'Review', '3.0', 'Approved'],
        ['Wed 18', 'MOD-14 rollout', 'Config', '7.0', 'Submitted'],
        ['Thu 19', 'Internal', 'Standup', '1.5', 'Draft'],
        ['Fri 20', 'MOD-14 rollout', 'Testing', '5.0', 'Draft'],
      ],
      statuses: ['Approved', 'Submitted', 'Draft'],
    },
  },
  'mod-12-support-tickets': {
    body: 'Inbound queue, assignment, status tracking, and SLA timers. Email and web intake.',
    overview:
      'An inbound support queue with assignment, a config-driven status workflow, an append-only timeline and derived SLA timers. Two intake channels — a public web form and an authenticated email-ingestion endpoint — feed a single self-contained app with no external services, no message broker and no cron.',
    features: [
      'Inbound queue with assignment and config-driven statuses',
      'Append-only ticket timeline',
      'SLA timers derived, not stored',
      'Web-form and email intake in one app',
    ],
    screen: {
      variant: 'board',
      accent: '#C08B8B',
      nav: ['Queue', 'Assigned', 'SLA', 'Settings'],
      boardColumns: [
        { title: 'New', cards: ['#7712 Login fails', '#7710 Export bug'] },
        { title: 'Open', cards: ['#7705 Slow report', '#7701 PDF layout'] },
        { title: 'Waiting', cards: ['#7698 Refund'] },
        { title: 'Resolved', cards: ['#7690 Typo', '#7688 Access'] },
      ],
    },
  },
  'mod-13-offers': {
    body: 'Write, send, and track sales offers. Line-item quotes with discounts, validity dates, PDF export, and a customer acceptance link.',
    overview:
      'A single-admin tool for composing line-item offers (quotes / Angebote) with per-line discounts and VAT, sending them to customers via a signed acceptance link, and tracking the outcome — accepted, rejected, expired, withdrawn or superseded by a revision. Self-contained: one package.json, no external services, MIT.',
    features: [
      'Line-item offers with per-line discounts and VAT',
      'Validity dates and PDF export',
      'Signed customer acceptance link',
      'Outcome tracking — accepted, rejected, expired, superseded',
    ],
    screen: {
      variant: 'detail',
      accent: '#C7A76B',
      nav: ['Offers', 'Customers', 'Templates'],
      recordTitle: 'Offer A-2026-091',
      list: ['091 · Sent', '090 · Accepted', '089 · Expired', '088 · Rejected'],
      fields: [
        { label: 'Customer', value: 'Nordwind AG' },
        { label: 'Valid until', value: '31 Jul 2026' },
        { label: 'Discount', value: '−€ 240.00' },
        { label: 'Gross', value: '€ 5,712.00' },
      ],
    },
  },
  'mod-14-subsidies-funds': {
    body: 'Track funding programs, applications, approvals, disbursements, and reporting deadlines. Never miss a grant deadline again.',
    overview:
      'Built entirely from the applicant’s point of view: discover public and private funding programs (Förderungen), apply to them, track approvals, receive money in tranches (disbursements) and stay on top of the post-award reports you owe. It tracks your pipeline of applications and your obligations — not a grantor’s budget.',
    features: [
      'Pipeline of funding programs and applications',
      'Approval and disbursement (tranche) tracking',
      'Post-award reporting deadlines',
      'Applicant-side — never miss a grant deadline',
    ],
    screen: {
      variant: 'table',
      accent: '#6B8FB5',
      nav: ['Programs', 'Applications', 'Disbursements', 'Deadlines'],
      columns: ['Program', 'Applied', 'Amount', 'Next report', 'Status'],
      rows: [
        ['FFG Basis', '10 Jan', '€ 120,000', '30 Sep', 'Approved'],
        ['aws Digital', '02 Feb', '€ 45,000', '—', 'Submitted'],
        ['EU Horizon', '18 Mar', '€ 300,000', '15 Aug', 'Approved'],
        ['Klima Fund', '05 Apr', '€ 28,000', '—', 'Draft'],
        ['Land NÖ', '21 May', '€ 12,500', '01 Dec', 'Approved'],
      ],
      statuses: ['Approved', 'Submitted', 'Draft'],
    },
  },
  'mod-15-workspace': {
    body: 'One screen for every module you run. Drag-and-drop widgets fed live by your modules, one shared customer filter, and cross-module actions.',
    overview:
      'A dashboard that hosts the other modules rather than replacing them. Each module you licensed contributes widgets — figures and short lists it computes itself — which you arrange on a board per person. Pick a customer once and every widget narrows to them. Open a module full-screen inside the Workspace, already signed in, or act across modules without opening either: a deal becomes a draft quote, an accepted quote becomes a draft invoice, and the work becomes a project to book time against — three buttons on the board, each recorded against you in the module it touched. Every module still installs and runs on its own; nothing here is a second copy of anything.',
    features: [
      'Per-person drag-and-drop board of live module widgets',
      'One shared customer and date filter every module honours',
      'Modules embedded full-screen, signed in, no second login',
      'Cross-module actions that run as you, not as a service account',
    ],
    screen: {
      // Not `dashboard`: that variant draws four tiles and a revenue chart, which
      // is a report, not a shell. This module's whole point is that every panel
      // belongs to a DIFFERENT module and that you arrange them yourself, so the
      // mockup has to show the source labels, the board tabs and a widget being
      // dragged — or it advertises the wrong product.
      variant: 'workspace',
      accent: '#8FA98C',
      nav: [],
      boards: ['Overview', 'Finance', 'Delivery'],
      contextChip: 'Blaustern Café GmbH',
      widgets: [
        { source: 'OFFERS', label: 'Offers out', value: '7', x: 0, y: 0, w: 3, h: 2 },
        { source: 'INVOICING', label: 'Outstanding', value: '€ 42,180', x: 3, y: 0, w: 3, h: 2 },
        { source: 'CRM', label: 'Weighted pipeline', value: '€ 85,725', x: 6, y: 0, w: 3, h: 2 },
        { source: 'TIME', label: 'Billable share', value: '93 %', x: 9, y: 0, w: 3, h: 2 },
        {
          source: 'OFFERS',
          label: 'Accepted, ready to bill',
          rows: ['AN-2026-0007 · Rollout', 'AN-2026-0011 · Wartung', 'AN-2026-0014 · Ausbau'],
          x: 0,
          y: 2,
          w: 5,
          h: 3,
        },
        {
          source: 'SUPPORT',
          label: 'Waiting longest',
          rows: ['#4120 · 3d · SLA breached', '#4118 · 2d · Unassigned', '#4109 · 1d · Open'],
          x: 5,
          y: 2,
          w: 4,
          h: 3,
        },
        // Mid-drag, exactly as the real grid previews one: lifted, outlined, and
        // overlapping its neighbour because the board never reflows what you did
        // not touch (see Board.tsx).
        {
          source: 'CRM',
          label: 'Follow-ups due',
          rows: ['Helios · Angebot nachfassen', 'Nordwind · Termin'],
          x: 8,
          y: 2,
          w: 4,
          h: 3,
          dragging: true,
        },
        // The shell's own widget: one feed over every module, read from PS-07.
        {
          source: 'WORKSPACE',
          label: 'Activity',
          rows: [
            'ada@acme.test · offer.sent · OFFERS · AN-2026-0014',
            'ada@acme.test · invoice.issued · INVOICING · RE-2026-0087',
          ],
          x: 0,
          y: 5,
          w: 12,
          h: 2,
        },
      ],
    },
  },
  'mod-16-mosaic': {
    body: 'The modules themselves, side by side. Whole apps in a grid you arrange, each one already signed in.',
    overview:
      'Where the Workspace summarises your modules, Mosaic runs them. Every pane is a whole module — its real interface, everything it can do — in its own frame on a grid you drag and resize. Open Invoicing next to Offers next to the CRM and work across all three without a single tab switch or a second login: each pane signs itself in through a one-time ticket, so the module mints its own session and this one never sees a credential. Nothing is reimplemented here, and nothing is summarised; the modules are simply present. Every one of them still installs and runs on its own.',
    features: [
      'Whole modules as panes — the real UI, not a widget over it',
      'Drag and resize on a 12-column grid, saved per person',
      'Each pane already signed in, through a single-use handoff ticket',
      'Named boards for the arrangements you keep coming back to',
    ],
    screen: {
      variant: 'mosaic',
      accent: '#9A8FB5',
      nav: [],
      boards: ['Sales desk', 'Month end'],
      panes: [
        {
          n: 'MOD-13',
          label: 'Offers',
          rows: ['AN-2026-0007 · Rollout · ACCEPTED', 'AN-2026-0011 · Wartung · SENT', 'AN-2026-0014 · Ausbau · DRAFT'],
          x: 0,
          y: 0,
          w: 6,
          h: 4,
        },
        {
          n: 'MOD-04',
          label: 'Invoicing',
          rows: ['RE-2026-0087 · € 4,180 · OVERDUE', 'RE-2026-0086 · € 1,240 · SENT', 'RE-2026-0085 · € 890 · PAID'],
          x: 6,
          y: 0,
          w: 6,
          h: 4,
        },
        {
          n: 'MOD-10',
          label: 'CRM',
          rows: ['Helios · Battery pilot · € 12,000', 'Nordwind · Warehouse · € 48,000', 'Alpine · Hosting · € 30,000'],
          x: 0,
          y: 4,
          w: 5,
          h: 3,
        },
        {
          n: 'MOD-12',
          label: 'Support',
          rows: ['#4120 · SLA breached · 3d', '#4118 · Unassigned · 2d', '#4109 · Open · 1d'],
          x: 5,
          y: 4,
          w: 7,
          h: 3,
        },
      ],
    },
  },
};

function entryFor(mod: ModuleRegistryEntry): ModuleEntry {
  const copy = presentation[mod.id];
  if (!copy) throw new Error(`modules/registry.json lists ${mod.id} but src/data/modules.ts has no copy for it`);
  return {
    n: mod.n,
    slug: mod.slug,
    folder: mod.id,
    title: mod.title,
    scope: mod.scope,
    source: `${REPO}/${mod.id}`,
    ...copy,
  };
}

/** Catalogue order is the registry's order (MOD-01 … MOD-15). */
export const modules: ModuleEntry[] = registryModules.map(entryFor);

export function getModule(slug: string): ModuleEntry | undefined {
  return modules.find((m) => m.slug === slug);
}
