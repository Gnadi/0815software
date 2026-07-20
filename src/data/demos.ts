// ─── Live-demo configuration for every module ─────────────────────────────
// Each module maps to a small, self-contained interactive demo rendered
// entirely client-side (no backend) from seeded, illustrative data. The
// shared renderer lives in src/lib/demo-engine.ts and understands the view
// types declared below. Data here is representative — not a real dataset.

export interface Stat { label: string; value: string; sub?: string; id?: string }
export interface Column { key: string; label: string; cls?: 'mono' | 'num' | 'dim'; status?: boolean }

export interface TimelineEvent { label: string; at: string; done?: boolean }
export interface LineItem { desc: string; qty: number; price: number; vat?: number }

export type DetailSection =
  | { kind: 'fields'; title: string; fields: { label: string; key: string }[] }
  | { kind: 'timeline'; title: string; key: string }
  | { kind: 'lines'; title: string; key: string }
  | { kind: 'note'; title: string; key: string };

export interface DetailSpec { titleKey: string; sections: DetailSection[] }

export interface ListView {
  type: 'list';
  search?: boolean;
  searchKeys?: string[];
  filterKey?: string;
  filters?: { label: string; value: string }[];
  bulk?: boolean;
  columns: Column[];
  rows: Record<string, any>[];
  detail?: DetailSpec;
}

export interface BoardView {
  type: 'board';
  stages: { id: string; label: string; terminal?: boolean }[];
  cards: { id: string; title: string; sub: string; value?: string; stage: string }[];
}

export interface CatalogView {
  type: 'catalog';
  products: { id: string; name: string; sku: string; price: number; stock: number; cat: string }[];
}

export interface ReportView {
  type: 'report';
  metrics: { id: string; label: string; unit?: string; series: { label: string; value: number }[] }[];
}

export interface TimesheetView {
  type: 'timesheet';
  week: string;
  days: string[];
  projects: { name: string; rateEur: number; minutes: number[] }[];
}

export interface TreeView {
  type: 'tree';
  nodes: { id: string; name: string; role: string; dept: string; managerId: string | null }[];
}

export interface BuilderView {
  type: 'builder';
  customer: string;
  title: string;
  vat: number;
  lines: { desc: string; qty: number; price: number; discount?: number }[];
}

export type Tab = { id: string; label: string } & (
  | ListView | BoardView | CatalogView | ReportView | TimesheetView | TreeView | BuilderView
);

export interface DemoConfig {
  slug: string;
  headline: string;
  loginHint?: string;
  stats: Stat[];
  tabs: Tab[];
}

// Small helpers to keep the seed data terse.
const ev = (label: string, at: string, done = true): TimelineEvent => ({ label, at, done });

export const demos: Record<string, DemoConfig> = {
  // ── MOD-01 ───────────────────────────────────────────────────────────────
  'customer-portal': {
    slug: 'customer-portal',
    headline: 'Signed in as ACME Foods GmbH — you only ever see your own orders and documents.',
    loginHint: 'demo@acme-foods.example',
    stats: [
      { label: 'Open orders', value: '2' },
      { label: 'In transit', value: '1' },
      { label: 'Documents', value: '6' },
    ],
    tabs: [
      {
        id: 'orders', label: 'Orders',
        type: 'list', search: true, searchKeys: ['ref', 'summary'], filterKey: 'status',
        filters: [
          { label: 'All', value: '' }, { label: 'Placed', value: 'placed' },
          { label: 'Confirmed', value: 'confirmed' }, { label: 'Shipped', value: 'shipped' },
          { label: 'Delivered', value: 'delivered' },
        ],
        columns: [
          { key: 'ref', label: 'Order', cls: 'mono' },
          { key: 'date', label: 'Placed', cls: 'dim' },
          { key: 'summary', label: 'Items' },
          { key: 'total', label: 'Total', cls: 'num' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { ref: 'ORD-2026-0418', date: '2026-07-14', summary: '3 items · pallets, film', total: '€ 4,280.00', status: 'placed',
            lines: [ { desc: 'Euro pallet, heat-treated', qty: 40, price: 8.90 }, { desc: 'Stretch film 500mm', qty: 24, price: 12.40 }, { desc: 'Edge protectors (pack)', qty: 60, price: 4.10 } ],
            timeline: [ ev('Order placed', 'Jul 14'), ev('Payment confirmed', 'Jul 14', false), ev('Shipped', '—', false), ev('Delivered', '—', false) ] },
          { ref: 'ORD-2026-0402', date: '2026-07-08', summary: '2 items · cartons', total: '€ 1,910.00', status: 'shipped',
            lines: [ { desc: 'Corrugated carton A4', qty: 500, price: 0.62 }, { desc: 'Carton B2 double wall', qty: 200, price: 1.55 } ],
            timeline: [ ev('Order placed', 'Jul 08'), ev('Payment confirmed', 'Jul 08'), ev('Shipped', 'Jul 10'), ev('Delivered', '—', false) ] },
          { ref: 'ORD-2026-0361', date: '2026-06-22', summary: '1 item · tape', total: '€ 312.00', status: 'delivered',
            lines: [ { desc: 'Packing tape, 66m (case)', qty: 48, price: 6.50 } ],
            timeline: [ ev('Order placed', 'Jun 22'), ev('Payment confirmed', 'Jun 22'), ev('Shipped', 'Jun 23'), ev('Delivered', 'Jun 25') ] },
          { ref: 'ORD-2026-0340', date: '2026-06-11', summary: '4 items · mixed', total: '€ 6,740.00', status: 'delivered',
            lines: [ { desc: 'Euro pallet, heat-treated', qty: 120, price: 8.90 }, { desc: 'Strapping band roll', qty: 30, price: 22.00 }, { desc: 'Corner guards (pack)', qty: 80, price: 4.10 }, { desc: 'Labels, thermal (roll)', qty: 40, price: 9.90 } ],
            timeline: [ ev('Order placed', 'Jun 11'), ev('Payment confirmed', 'Jun 11'), ev('Shipped', 'Jun 12'), ev('Delivered', 'Jun 14') ] },
        ],
        detail: {
          titleKey: 'ref',
          sections: [
            { kind: 'lines', title: 'Line items', key: 'lines' },
            { kind: 'timeline', title: 'Status', key: 'timeline' },
          ],
        },
      },
      {
        id: 'docs', label: 'Documents',
        type: 'list', search: true, searchKeys: ['name'], filterKey: 'type',
        filters: [ { label: 'All', value: '' }, { label: 'Invoice', value: 'Invoice' }, { label: 'Delivery note', value: 'Delivery note' }, { label: 'Statement', value: 'Statement' } ],
        columns: [
          { key: 'name', label: 'Document', cls: 'mono' },
          { key: 'type', label: 'Type' },
          { key: 'date', label: 'Date', cls: 'dim' },
          { key: 'size', label: 'Size', cls: 'num' },
        ],
        rows: [
          { name: 'INV-2026-0418.pdf', type: 'Invoice', date: '2026-07-14', size: '48 KB' },
          { name: 'DN-2026-0402.pdf', type: 'Delivery note', date: '2026-07-10', size: '31 KB' },
          { name: 'INV-2026-0402.pdf', type: 'Invoice', date: '2026-07-08', size: '46 KB' },
          { name: 'STMT-2026-Q2.pdf', type: 'Statement', date: '2026-07-01', size: '72 KB' },
          { name: 'INV-2026-0361.pdf', type: 'Invoice', date: '2026-06-22', size: '44 KB' },
          { name: 'DN-2026-0340.pdf', type: 'Delivery note', date: '2026-06-12', size: '33 KB' },
        ],
      },
    ],
  },

  // ── MOD-02 ───────────────────────────────────────────────────────────────
  'admin-dashboard': {
    slug: 'admin-dashboard',
    headline: 'A config-driven CRUD table — search, filter, multi-select and export, generated from one schema file.',
    stats: [
      { label: 'Records', value: '128' },
      { label: 'Active', value: '104' },
      { label: 'Archived', value: '24' },
    ],
    tabs: [
      {
        id: 'customers', label: 'Customers',
        type: 'list', search: true, searchKeys: ['name', 'city'], bulk: true, filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Active', value: 'active' }, { label: 'Trial', value: 'trial' }, { label: 'Archived', value: 'archived' } ],
        columns: [
          { key: 'name', label: 'Company' },
          { key: 'plan', label: 'Plan', cls: 'mono' },
          { key: 'city', label: 'City', cls: 'dim' },
          { key: 'mrr', label: 'MRR', cls: 'num' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { name: 'Nordwind Logistik', plan: 'TEAM', city: 'Hamburg', mrr: '€ 0.00', status: 'active' },
          { name: 'Salzkammer Bäckerei', plan: 'SOLO', city: 'Bad Ischl', mrr: '€ 0.00', status: 'active' },
          { name: 'Donau Kliniken', plan: 'ENTERPRISE', city: 'Wien', mrr: '€ 0.00', status: 'active' },
          { name: 'Feldbach Möbel', plan: 'TEAM', city: 'Graz', mrr: '€ 0.00', status: 'trial' },
          { name: 'Tiroler Werkzeug', plan: 'SOLO', city: 'Innsbruck', mrr: '€ 0.00', status: 'active' },
          { name: 'Adria Reederei', plan: 'TEAM', city: 'Triest', mrr: '€ 0.00', status: 'archived' },
          { name: 'Wachau Weingut', plan: 'SOLO', city: 'Dürnstein', mrr: '€ 0.00', status: 'trial' },
          { name: 'Bregenz Textil', plan: 'ENTERPRISE', city: 'Bregenz', mrr: '€ 0.00', status: 'active' },
        ],
      },
    ],
  },

  // ── MOD-03 ───────────────────────────────────────────────────────────────
  'inventory-management': {
    slug: 'inventory-management',
    headline: 'Stock levels are never stored — they are derived from an append-only movements ledger.',
    stats: [
      { label: 'SKUs', value: '42' },
      { label: 'Warehouses', value: '3' },
      { label: 'Low stock', value: '2' },
    ],
    tabs: [
      {
        id: 'stock', label: 'Stock levels',
        type: 'list', search: true, searchKeys: ['sku', 'name'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'In stock', value: 'ok' }, { label: 'Low', value: 'low' }, { label: 'Out', value: 'out' } ],
        columns: [
          { key: 'sku', label: 'SKU', cls: 'mono' },
          { key: 'name', label: 'Product' },
          { key: 'wh', label: 'Warehouse', cls: 'dim' },
          { key: 'onhand', label: 'On hand', cls: 'num' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { sku: 'PAL-EUR-HT', name: 'Euro pallet, heat-treated', wh: 'Linz DC', onhand: '1,240', status: 'ok', ledger: [ ev('Goods in · PO-2211', 'Jul 12'), ev('Transfer out → Wels', 'Jul 09'), ev('Stocktake +12', 'Jul 01') ] },
          { sku: 'FILM-500', name: 'Stretch film 500mm', wh: 'Linz DC', onhand: '86', status: 'low', ledger: [ ev('Goods out · ORD-0418', 'Jul 14'), ev('Goods in · PO-2208', 'Jul 05') ] },
          { sku: 'CTN-A4', name: 'Corrugated carton A4', wh: 'Wels DC', onhand: '9,800', status: 'ok', ledger: [ ev('Goods in · PO-2209', 'Jul 10'), ev('Goods out · ORD-0402', 'Jul 08') ] },
          { sku: 'TAPE-66', name: 'Packing tape, 66m', wh: 'Wels DC', onhand: '0', status: 'out', ledger: [ ev('Goods out · ORD-0361', 'Jun 22'), ev('Stocktake -4', 'Jun 20') ] },
          { sku: 'STRAP-16', name: 'Strapping band roll', wh: 'Salzburg DC', onhand: '312', status: 'ok', ledger: [ ev('Goods in · PO-2205', 'Jun 28') ] },
          { sku: 'LBL-THERM', name: 'Labels, thermal (roll)', wh: 'Linz DC', onhand: '58', status: 'low', ledger: [ ev('Goods out · ORD-0340', 'Jun 11'), ev('Goods in · PO-2201', 'Jun 02') ] },
        ],
        detail: { titleKey: 'name', sections: [ { kind: 'fields', title: 'Details', fields: [ { label: 'SKU', key: 'sku' }, { label: 'Warehouse', key: 'wh' }, { label: 'On hand', key: 'onhand' } ] }, { kind: 'timeline', title: 'Movements ledger', key: 'ledger' } ] },
      },
    ],
  },

  // ── MOD-04 ───────────────────────────────────────────────────────────────
  'invoice-billing': {
    slug: 'invoice-billing',
    headline: 'Totals are derived from lines, numbering is gapless per year, and sent invoices are immutable.',
    stats: [
      { label: 'Outstanding', value: '€ 18,410' },
      { label: 'Overdue', value: '1' },
      { label: 'Paid (Jul)', value: '€ 9,120' },
    ],
    tabs: [
      {
        id: 'invoices', label: 'Invoices',
        type: 'list', search: true, searchKeys: ['ref', 'customer'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Draft', value: 'draft' }, { label: 'Sent', value: 'sent' }, { label: 'Paid', value: 'paid' }, { label: 'Overdue', value: 'overdue' } ],
        columns: [
          { key: 'ref', label: 'Number', cls: 'mono' },
          { key: 'customer', label: 'Customer' },
          { key: 'due', label: 'Due', cls: 'dim' },
          { key: 'gross', label: 'Gross', cls: 'num' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { ref: 'INV-2026-0114', customer: 'Nordwind Logistik', due: '2026-08-13', gross: '€ 5,136.00', status: 'sent',
            lines: [ { desc: 'Consulting, July', qty: 32, price: 120.00, vat: 20 }, { desc: 'Hosting (month)', qty: 1, price: 480.00, vat: 20 } ],
            timeline: [ ev('Draft created', 'Jul 14'), ev('Finalized · INV-2026-0114', 'Jul 14'), ev('Sent', 'Jul 14'), ev('Paid', '—', false) ] },
          { ref: 'INV-2026-0113', customer: 'Donau Kliniken', due: '2026-07-01', gross: '€ 3,240.00', status: 'overdue',
            lines: [ { desc: 'Integration work', qty: 24, price: 120.00, vat: 20 } ],
            timeline: [ ev('Finalized', 'Jun 15'), ev('Sent', 'Jun 15'), ev('Reminder sent', 'Jul 05'), ev('Paid', '—', false) ] },
          { ref: 'INV-2026-0112', customer: 'Feldbach Möbel', due: '2026-07-20', gross: '€ 1,080.00', status: 'paid',
            lines: [ { desc: 'Support retainer', qty: 1, price: 900.00, vat: 20 } ],
            timeline: [ ev('Finalized', 'Jun 30'), ev('Sent', 'Jun 30'), ev('Paid', 'Jul 09') ] },
          { ref: 'DRAFT', customer: 'Tiroler Werkzeug', due: '—', gross: '€ 2,160.00', status: 'draft',
            lines: [ { desc: 'Data migration', qty: 18, price: 120.00, vat: 20 } ],
            timeline: [ ev('Draft created', 'Jul 18'), ev('Finalized', '—', false) ] },
        ],
        detail: { titleKey: 'ref', sections: [ { kind: 'lines', title: 'Line items', key: 'lines' }, { kind: 'timeline', title: 'Lifecycle', key: 'timeline' } ] },
      },
    ],
  },

  // ── MOD-05 ───────────────────────────────────────────────────────────────
  'employee-directory': {
    slug: 'employee-directory',
    headline: 'The manager graph is a forest — no cycles — and employees are offboarded, never deleted.',
    stats: [
      { label: 'Headcount', value: '9' },
      { label: 'Departments', value: '4' },
      { label: 'Managers', value: '3' },
    ],
    tabs: [
      {
        id: 'directory', label: 'Directory',
        type: 'list', search: true, searchKeys: ['name', 'role'], filterKey: 'dept',
        filters: [ { label: 'All', value: '' }, { label: 'Engineering', value: 'Engineering' }, { label: 'Sales', value: 'Sales' }, { label: 'Ops', value: 'Ops' }, { label: 'Finance', value: 'Finance' } ],
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'role', label: 'Role', cls: 'dim' },
          { key: 'dept', label: 'Dept', cls: 'mono' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { name: 'Anja Berger', role: 'Managing Director', dept: 'Ops', status: 'active' },
          { name: 'Lukas Moser', role: 'Head of Engineering', dept: 'Engineering', status: 'active' },
          { name: 'Petra Huber', role: 'Head of Sales', dept: 'Sales', status: 'active' },
          { name: 'Jonas Weber', role: 'Backend Engineer', dept: 'Engineering', status: 'active' },
          { name: 'Marie Fischer', role: 'Frontend Engineer', dept: 'Engineering', status: 'active' },
          { name: 'Felix Bauer', role: 'Account Executive', dept: 'Sales', status: 'active' },
          { name: 'Sara Wolf', role: 'Accountant', dept: 'Finance', status: 'active' },
          { name: 'Tom Gruber', role: 'Support Lead', dept: 'Ops', status: 'offboarded' },
        ],
      },
      {
        id: 'org', label: 'Org chart',
        type: 'tree',
        nodes: [
          { id: 'a', name: 'Anja Berger', role: 'Managing Director', dept: 'Ops', managerId: null },
          { id: 'b', name: 'Lukas Moser', role: 'Head of Engineering', dept: 'Engineering', managerId: 'a' },
          { id: 'c', name: 'Petra Huber', role: 'Head of Sales', dept: 'Sales', managerId: 'a' },
          { id: 'd', name: 'Jonas Weber', role: 'Backend Engineer', dept: 'Engineering', managerId: 'b' },
          { id: 'e', name: 'Marie Fischer', role: 'Frontend Engineer', dept: 'Engineering', managerId: 'b' },
          { id: 'f', name: 'Felix Bauer', role: 'Account Executive', dept: 'Sales', managerId: 'c' },
          { id: 'g', name: 'Sara Wolf', role: 'Accountant', dept: 'Finance', managerId: 'a' },
        ],
      },
    ],
  },

  // ── MOD-06 ───────────────────────────────────────────────────────────────
  'procurement-tracker': {
    slug: 'procurement-tracker',
    headline: 'Approval tiers are derived from the total and frozen at submit; approvals are append-only.',
    stats: [
      { label: 'In approval', value: '2' },
      { label: 'Awaiting order', value: '1' },
      { label: 'Q3 committed', value: '€ 84,200' },
    ],
    tabs: [
      {
        id: 'pos', label: 'Purchase orders',
        type: 'list', search: true, searchKeys: ['ref', 'supplier'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Draft', value: 'draft' }, { label: 'Submitted', value: 'submitted' }, { label: 'Approved', value: 'approved' }, { label: 'Ordered', value: 'ordered' } ],
        columns: [
          { key: 'ref', label: 'PO', cls: 'mono' },
          { key: 'supplier', label: 'Supplier' },
          { key: 'total', label: 'Total', cls: 'num' },
          { key: 'tiers', label: 'Tiers', cls: 'dim' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { ref: 'PO-2026-0211', supplier: 'Steinbach Stahl', total: '€ 42,000.00', tiers: '2 of 2', status: 'submitted',
            lines: [ { desc: 'Steel beam IPE 200 (6m)', qty: 40, price: 620.00 }, { desc: 'Anchor set', qty: 200, price: 42.00 } ],
            timeline: [ ev('Submitted · tiers frozen', 'Jul 15'), ev('Tier 1 approved · Head of Ops', 'Jul 16'), ev('Tier 2 pending · MD', '—', false) ] },
          { ref: 'PO-2026-0210', supplier: 'Kunststoff Ober', total: '€ 8,400.00', tiers: '1 of 1', status: 'approved',
            lines: [ { desc: 'HDPE granulate (t)', qty: 12, price: 700.00 } ],
            timeline: [ ev('Submitted', 'Jul 12'), ev('Tier 1 approved · Head of Ops', 'Jul 13') ] },
          { ref: 'PO-2026-0209', supplier: 'Elektro Reiter', total: '€ 33,800.00', tiers: '2 of 2', status: 'ordered',
            lines: [ { desc: 'Control cabinet', qty: 4, price: 6200.00 }, { desc: 'PLC module', qty: 8, price: 1150.00 } ],
            timeline: [ ev('Submitted', 'Jul 02'), ev('Tier 1 approved', 'Jul 03'), ev('Tier 2 approved · MD', 'Jul 04'), ev('Ordered', 'Jul 05') ] },
          { ref: 'PO-2026-0212', supplier: 'Holz Wagner', total: '€ 2,300.00', tiers: '1 of 1', status: 'draft',
            lines: [ { desc: 'Plywood sheet 18mm', qty: 60, price: 38.00 } ],
            timeline: [ ev('Draft created', 'Jul 18'), ev('Submitted', '—', false) ] },
        ],
        detail: { titleKey: 'ref', sections: [ { kind: 'lines', title: 'Order lines', key: 'lines' }, { kind: 'timeline', title: 'Approval history', key: 'timeline' } ] },
      },
    ],
  },

  // ── MOD-07 ───────────────────────────────────────────────────────────────
  'storefront': {
    slug: 'storefront',
    headline: 'Public shop — add items to the cart and the totals recompute; checkout is atomic against stock.',
    stats: [
      { label: 'Products', value: '6' },
      { label: 'In cart', value: '0', sub: 'items', id: 'cartCount' },
      { label: 'Cart total', value: '€ 0.00', id: 'cartTotal' },
    ],
    tabs: [
      {
        id: 'shop', label: 'Shop',
        type: 'catalog',
        products: [
          { id: 'p1', name: 'Filter coffee, 1kg', sku: 'COF-1000', price: 18.90, stock: 40, cat: 'Coffee' },
          { id: 'p2', name: 'Espresso beans, 1kg', sku: 'ESP-1000', price: 22.50, stock: 26, cat: 'Coffee' },
          { id: 'p3', name: 'Ceramic mug', sku: 'MUG-STD', price: 9.90, stock: 120, cat: 'Ware' },
          { id: 'p4', name: 'AeroPress', sku: 'BRW-AERO', price: 34.00, stock: 12, cat: 'Brew' },
          { id: 'p5', name: 'Paper filters (100)', sku: 'FLT-100', price: 5.40, stock: 3, cat: 'Brew' },
          { id: 'p6', name: 'Gift box, mixed', sku: 'GFT-MIX', price: 49.00, stock: 8, cat: 'Gifts' },
        ],
      },
    ],
  },

  // ── MOD-08 ───────────────────────────────────────────────────────────────
  'reporting-suite': {
    slug: 'reporting-suite',
    headline: 'Saved SELECT-only reports become server-computed charts — switch the metric to redraw.',
    stats: [
      { label: 'Saved reports', value: '7' },
      { label: 'Charts', value: '4' },
      { label: 'Scheduled', value: '2', sub: 'exports' },
    ],
    tabs: [
      {
        id: 'report', label: 'Report',
        type: 'report',
        metrics: [
          { id: 'rev', label: 'Revenue by month', unit: 'k€', series: [
            { label: 'Feb', value: 41 }, { label: 'Mar', value: 47 }, { label: 'Apr', value: 52 },
            { label: 'May', value: 49 }, { label: 'Jun', value: 61 }, { label: 'Jul', value: 68 },
          ] },
          { id: 'reg', label: 'Orders by region', unit: '', series: [
            { label: 'AT', value: 312 }, { label: 'DE', value: 288 }, { label: 'CH', value: 141 },
            { label: 'IT', value: 96 }, { label: 'Other', value: 54 },
          ] },
          { id: 'top', label: 'Top products', unit: 'units', series: [
            { label: 'Coffee', value: 820 }, { label: 'Mugs', value: 540 }, { label: 'Filters', value: 410 },
            { label: 'Brew', value: 220 }, { label: 'Gifts', value: 130 },
          ] },
        ],
      },
    ],
  },

  // ── MOD-09 ───────────────────────────────────────────────────────────────
  'document-management': {
    slug: 'document-management',
    headline: 'Access is matter-based — you see a matter only if you were granted membership on it.',
    stats: [
      { label: 'Matters', value: '3' },
      { label: 'Documents', value: '12' },
      { label: 'Versions', value: '31' },
    ],
    tabs: [
      {
        id: 'matters', label: 'Matters',
        type: 'list', search: true, searchKeys: ['name', 'client'],
        columns: [
          { key: 'name', label: 'Matter' },
          { key: 'client', label: 'Client', cls: 'dim' },
          { key: 'docs', label: 'Docs', cls: 'num' },
          { key: 'access', label: 'Your access', status: true },
        ],
        rows: [
          { name: 'M-2026-014 Acquisition', client: 'Donau Kliniken', docs: '6', access: 'owner' },
          { name: 'M-2026-009 Lease review', client: 'Feldbach Möbel', docs: '4', access: 'editor' },
          { name: 'M-2026-003 NDA bundle', client: 'Nordwind Logistik', docs: '2', access: 'viewer' },
        ],
      },
      {
        id: 'docs', label: 'Documents',
        type: 'list', search: true, searchKeys: ['name', 'matter'], filterKey: 'matter',
        filters: [ { label: 'All', value: '' }, { label: 'Acquisition', value: 'M-2026-014' }, { label: 'Lease review', value: 'M-2026-009' }, { label: 'NDA bundle', value: 'M-2026-003' } ],
        columns: [
          { key: 'name', label: 'Document', cls: 'mono' },
          { key: 'matter', label: 'Matter', cls: 'dim' },
          { key: 'ver', label: 'Ver', cls: 'num' },
          { key: 'size', label: 'Size', cls: 'num' },
        ],
        rows: [
          { name: 'SPA_draft.docx', matter: 'M-2026-014', ver: 'v5', size: '210 KB', hist: [ ev('v5 · Anja Berger', 'Jul 14'), ev('v4 · Lukas Moser', 'Jul 09'), ev('v3 · Anja Berger', 'Jul 02'), ev('v2 · external', 'Jun 28'), ev('v1 · Anja Berger', 'Jun 20') ] },
          { name: 'due_diligence.xlsx', matter: 'M-2026-014', ver: 'v3', size: '88 KB', hist: [ ev('v3 · Sara Wolf', 'Jul 12'), ev('v2 · Sara Wolf', 'Jul 05'), ev('v1 · Sara Wolf', 'Jun 30') ] },
          { name: 'lease_2026.pdf', matter: 'M-2026-009', ver: 'v2', size: '156 KB', hist: [ ev('v2 · Marie Fischer', 'Jul 10'), ev('v1 · Marie Fischer', 'Jul 01') ] },
          { name: 'nda_mutual.pdf', matter: 'M-2026-003', ver: 'v1', size: '64 KB', hist: [ ev('v1 · Petra Huber', 'Jun 18') ] },
        ],
        detail: { titleKey: 'name', sections: [ { kind: 'timeline', title: 'Version history', key: 'hist' } ] },
      },
    ],
  },

  // ── MOD-10 ───────────────────────────────────────────────────────────────
  'crm-lite': {
    slug: 'crm-lite',
    headline: 'Click a deal to advance it — every stage change is an append-only event. Won and lost are terminal.',
    stats: [
      { label: 'Open deals', value: '6' },
      { label: 'Pipeline', value: '€ 214k' },
      { label: 'Win rate', value: '38%' },
    ],
    tabs: [
      {
        id: 'pipeline', label: 'Pipeline',
        type: 'board',
        stages: [
          { id: 'lead', label: 'Lead' },
          { id: 'qualified', label: 'Qualified' },
          { id: 'proposal', label: 'Proposal' },
          { id: 'won', label: 'Won', terminal: true },
          { id: 'lost', label: 'Lost', terminal: true },
        ],
        cards: [
          { id: 'd1', title: 'Nordwind Logistik', sub: 'Portal rollout', value: '€ 48,000', stage: 'proposal' },
          { id: 'd2', title: 'Donau Kliniken', sub: 'Reporting suite', value: '€ 62,000', stage: 'qualified' },
          { id: 'd3', title: 'Feldbach Möbel', sub: 'Storefront', value: '€ 21,000', stage: 'lead' },
          { id: 'd4', title: 'Tiroler Werkzeug', sub: 'Inventory', value: '€ 34,000', stage: 'proposal' },
          { id: 'd5', title: 'Wachau Weingut', sub: 'CRM Lite', value: '€ 12,000', stage: 'lead' },
          { id: 'd6', title: 'Bregenz Textil', sub: 'Admin dashboard', value: '€ 37,000', stage: 'qualified' },
          { id: 'd7', title: 'Adria Reederei', sub: 'Procurement', value: '€ 55,000', stage: 'won' },
        ],
      },
    ],
  },

  // ── MOD-11 ───────────────────────────────────────────────────────────────
  'time-tracking': {
    slug: 'time-tracking',
    headline: 'Time is integer minutes; the billable amount is derived from exact minutes and the project rate.',
    stats: [
      { label: 'This week', value: '38.5 h' },
      { label: 'Billable', value: '€ 3,465' },
      { label: 'Status', value: 'Draft' },
    ],
    tabs: [
      {
        id: 'week', label: 'Timesheet',
        type: 'timesheet',
        week: 'Week 29 · Jul 13–19, 2026',
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        projects: [
          { name: 'Nordwind · Portal', rateEur: 120, minutes: [180, 240, 120, 0, 90] },
          { name: 'Donau · Reporting', rateEur: 90, minutes: [120, 60, 240, 300, 180] },
          { name: 'Internal · Ops', rateEur: 0, minutes: [30, 0, 60, 0, 120] },
        ],
      },
    ],
  },

  // ── MOD-12 ───────────────────────────────────────────────────────────────
  'support-tickets': {
    slug: 'support-tickets',
    headline: 'A ticket’s status, assignee and SLA verdict are all derived from an append-only event stream.',
    stats: [
      { label: 'Open', value: '4' },
      { label: 'Breaching SLA', value: '1' },
      { label: 'Resolved today', value: '3' },
    ],
    tabs: [
      {
        id: 'queue', label: 'Queue',
        type: 'list', search: true, searchKeys: ['ref', 'subject', 'requester'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Open', value: 'open' }, { label: 'Pending', value: 'pending' }, { label: 'Resolved', value: 'resolved' } ],
        columns: [
          { key: 'ref', label: 'Ref', cls: 'mono' },
          { key: 'subject', label: 'Subject' },
          { key: 'priority', label: 'Priority', status: true },
          { key: 'sla', label: 'SLA', cls: 'dim' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { ref: 'TKT-2026-0231', subject: 'Login fails after password reset', requester: 'l.moser@nordwind.example', priority: 'urgent', sla: '02:10 left', status: 'open',
            thread: [ ev('Opened · web form', '09:12'), ev('Assigned · Felix', '09:20'), ev('Public reply sent', '10:02') ] },
          { ref: 'TKT-2026-0230', subject: 'Export CSV missing column', requester: 's.wolf@donau.example', priority: 'normal', sla: 'breached', status: 'open',
            thread: [ ev('Opened · email', 'Yesterday'), ev('Internal note', 'Yesterday'), ev('SLA breached', '08:00') ] },
          { ref: 'TKT-2026-0229', subject: 'Feature: bulk archive', requester: 'p.huber@feldbach.example', priority: 'low', sla: '3d left', status: 'pending',
            thread: [ ev('Opened · web form', 'Jul 16'), ev('Assigned · Marie', 'Jul 16'), ev('Waiting on customer', 'Jul 17') ] },
          { ref: 'TKT-2026-0228', subject: 'Invoice PDF not downloading', requester: 'a.berger@acme.example', priority: 'high', sla: 'met', status: 'resolved',
            thread: [ ev('Opened · email', 'Jul 15'), ev('Assigned · Felix', 'Jul 15'), ev('Resolved', 'Jul 15') ] },
        ],
        detail: { titleKey: 'ref', sections: [ { kind: 'fields', title: 'Ticket', fields: [ { label: 'Requester', key: 'requester' }, { label: 'Priority', key: 'priority' }, { label: 'SLA', key: 'sla' } ] }, { kind: 'timeline', title: 'Timeline', key: 'thread' } ] },
      },
    ],
  },

  // ── MOD-13 ───────────────────────────────────────────────────────────────
  'offers': {
    slug: 'offers',
    headline: 'Compose an offer with per-line discounts and VAT — totals are derived live from the lines.',
    stats: [
      { label: 'Open value', value: '€ 41,200' },
      { label: 'Accepted', value: '5' },
      { label: 'Win rate', value: '45%' },
    ],
    tabs: [
      {
        id: 'offers', label: 'Offers',
        type: 'list', search: true, searchKeys: ['ref', 'customer', 'title'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Draft', value: 'draft' }, { label: 'Sent', value: 'sent' }, { label: 'Accepted', value: 'accepted' }, { label: 'Expired', value: 'expired' } ],
        columns: [
          { key: 'ref', label: 'Ref', cls: 'mono' },
          { key: 'customer', label: 'Customer' },
          { key: 'total', label: 'Total', cls: 'num' },
          { key: 'valid', label: 'Valid until', cls: 'dim' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { ref: 'OFF-2026-0088', customer: 'Bregenz Textil', title: 'Admin dashboard build', total: '€ 18,600.00', valid: '2026-08-15', status: 'sent',
            lines: [ { desc: 'Schema + CRUD build', qty: 1, price: 12000.00, vat: 20 }, { desc: 'Onboarding & handover', qty: 1, price: 3500.00, vat: 20 } ],
            timeline: [ ev('Draft created', 'Jul 12'), ev('Sent · acceptance link', 'Jul 12'), ev('Viewed by customer', 'Jul 14'), ev('Accepted', '—', false) ] },
          { ref: 'OFF-2026-0087', customer: 'Wachau Weingut', title: 'CRM Lite setup', total: '€ 9,800.00', valid: '2026-07-30', status: 'accepted',
            lines: [ { desc: 'CRM Lite deployment', qty: 1, price: 8000.00, vat: 20 } ],
            timeline: [ ev('Sent', 'Jun 28'), ev('Accepted', 'Jul 03') ] },
          { ref: 'OFF-2026-0085', customer: 'Adria Reederei', title: 'Procurement rollout', total: '€ 22,400.00', valid: '2026-06-30', status: 'expired',
            lines: [ { desc: 'Procurement tracker', qty: 1, price: 18000.00, vat: 20 } ],
            timeline: [ ev('Sent', 'Jun 05'), ev('Expired', 'Jun 30') ] },
        ],
        detail: { titleKey: 'ref', sections: [ { kind: 'lines', title: 'Line items', key: 'lines' }, { kind: 'timeline', title: 'Lifecycle', key: 'timeline' } ] },
      },
      {
        id: 'editor', label: 'New offer',
        type: 'builder',
        customer: 'Feldbach Möbel',
        title: 'Storefront build',
        vat: 20,
        lines: [
          { desc: 'Catalogue + checkout build', qty: 1, price: 14000, discount: 0 },
          { desc: 'Payment integration', qty: 1, price: 2800, discount: 10 },
          { desc: 'Staff training (day)', qty: 2, price: 900, discount: 0 },
        ],
      },
    ],
  },

  // ── MOD-14 ───────────────────────────────────────────────────────────────
  'subsidies-funds': {
    slug: 'subsidies-funds',
    headline: 'Remaining balance and reporting deadlines are derived — never miss a post-award report again.',
    stats: [
      { label: 'Requested', value: '€ 480k' },
      { label: 'Approved', value: '€ 310k' },
      { label: 'Disbursed', value: '€ 186k' },
    ],
    tabs: [
      {
        id: 'deadlines', label: 'Deadlines',
        type: 'list', search: true, searchKeys: ['item'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Overdue', value: 'overdue' }, { label: 'At risk', value: 'at-risk' }, { label: 'Upcoming', value: 'upcoming' } ],
        columns: [
          { key: 'item', label: 'Item' },
          { key: 'kind', label: 'Kind', cls: 'dim' },
          { key: 'due', label: 'Due', cls: 'mono' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { item: 'FFG Basisprogramm · interim report', kind: 'Report', due: '2026-07-10', status: 'overdue' },
          { item: 'aws Digitalisierung · milestone 2', kind: 'Report', due: '2026-07-25', status: 'at-risk' },
          { item: 'Klimafonds E-Mobility · application', kind: 'Deadline', due: '2026-08-14', status: 'upcoming' },
          { item: 'EU Horizon cluster · final report', kind: 'Report', due: '2026-09-30', status: 'upcoming' },
        ],
      },
      {
        id: 'apps', label: 'Applications',
        type: 'list', search: true, searchKeys: ['program'], filterKey: 'status',
        filters: [ { label: 'All', value: '' }, { label: 'Submitted', value: 'submitted' }, { label: 'Under review', value: 'under_review' }, { label: 'Approved', value: 'approved' } ],
        columns: [
          { key: 'program', label: 'Program' },
          { key: 'requested', label: 'Requested', cls: 'num' },
          { key: 'approved', label: 'Approved', cls: 'num' },
          { key: 'disbursed', label: 'Disbursed', cls: 'num' },
          { key: 'status', label: 'Status', status: true },
        ],
        rows: [
          { program: 'FFG Basisprogramm', requested: '€ 180,000', approved: '€ 150,000', disbursed: '€ 90,000', status: 'approved',
            tranches: [ ev('Tranche 1 · €60k', 'Feb 10'), ev('Tranche 2 · €30k', 'May 20'), ev('Tranche 3 · €60k', '—', false) ] },
          { program: 'aws Digitalisierung', requested: '€ 120,000', approved: '€ 100,000', disbursed: '€ 60,000', status: 'approved',
            tranches: [ ev('Tranche 1 · €40k', 'Mar 05'), ev('Tranche 2 · €20k', 'Jun 12'), ev('Tranche 3 · €40k', '—', false) ] },
          { program: 'Klimafonds E-Mobility', requested: '€ 90,000', approved: '€ 60,000', disbursed: '€ 36,000', status: 'under_review' },
          { program: 'EU Horizon cluster', requested: '€ 90,000', approved: '—', disbursed: '—', status: 'submitted' },
        ],
        detail: { titleKey: 'program', sections: [ { kind: 'fields', title: 'Funding', fields: [ { label: 'Requested', key: 'requested' }, { label: 'Approved', key: 'approved' }, { label: 'Disbursed', key: 'disbursed' } ] }, { kind: 'timeline', title: 'Disbursement tranches', key: 'tranches' } ] },
      },
    ],
  },
};
