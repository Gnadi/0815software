import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { hashPassword } from './auth.js';
import { formatMoney, type OrderStatus } from '../shared/types.js';

/**
 * Demo data: three customers of the fictional shop that MOD-02's admin
 * dashboard manages, each with their own orders, status timelines and
 * documents. Document files are generated as plain text at seed time —
 * no binary artifacts are committed anywhere.
 *
 * Dev credentials (documented in the README):
 *   anna.berger@example.de  / demo-anna
 *   l.steiner@example.at    / demo-lukas
 *   j.devries@example.nl    / demo-jan
 */

interface SeedItem {
  sku: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
}

interface SeedEvent {
  status: OrderStatus;
  at: string;
  note?: string;
}

interface SeedOrder {
  orderNo: string;
  items: SeedItem[];
  /** Chronological status history; the last entry is the current status. */
  events: SeedEvent[];
}

type DocType = 'invoice' | 'delivery_note' | 'statement';

interface SeedDocument {
  docType: DocType;
  number: string;
  title: string;
  /** Order this document belongs to; omit for standalone documents. */
  orderNo?: string;
  createdAt: string;
}

interface SeedCustomer {
  email: string;
  name: string;
  company: string;
  password: string;
  createdAt: string;
  orders: SeedOrder[];
  documents: SeedDocument[];
}

const CURRENCY = 'EUR';

const customers: SeedCustomer[] = [
  {
    email: 'anna.berger@example.de',
    name: 'Anna Berger',
    company: 'Berger Logistik GmbH',
    password: 'demo-anna',
    createdAt: '2025-03-14T10:00:00Z',
    orders: [
      {
        orderNo: 'ORD-1001',
        items: [
          { sku: 'HW-1001', description: 'Industrial Label Printer', quantity: 2, unitPriceCents: 64900 },
        ],
        events: [
          { status: 'placed', at: '2026-05-04T09:12:00Z' },
          { status: 'confirmed', at: '2026-05-04T14:30:00Z' },
          { status: 'shipped', at: '2026-05-06T08:05:00Z', note: 'Handed to carrier, 2 parcels' },
          { status: 'delivered', at: '2026-05-08T10:47:00Z', note: 'Signed for at goods entrance' },
        ],
      },
      {
        orderNo: 'ORD-1007',
        items: [
          { sku: 'SV-3002', description: 'Annual Maintenance', quantity: 1, unitPriceCents: 145000 },
        ],
        events: [
          { status: 'placed', at: '2026-06-15T11:02:00Z' },
          { status: 'confirmed', at: '2026-06-16T09:20:00Z' },
          { status: 'shipped', at: '2026-07-10T07:45:00Z', note: 'Service confirmation dispatched' },
        ],
      },
      {
        orderNo: 'ORD-1015',
        items: [
          { sku: 'AC-4001', description: 'Thermal Label Roll (10x)', quantity: 20, unitPriceCents: 2490 },
        ],
        events: [{ status: 'placed', at: '2026-07-14T16:21:00Z' }],
      },
    ],
    documents: [
      { docType: 'invoice', number: 'INV-2026-0451', title: 'Invoice INV-2026-0451', orderNo: 'ORD-1001', createdAt: '2026-05-04T15:00:00Z' },
      { docType: 'delivery_note', number: 'DN-2026-0389', title: 'Delivery note DN-2026-0389', orderNo: 'ORD-1001', createdAt: '2026-05-06T08:05:00Z' },
      { docType: 'invoice', number: 'INV-2026-0512', title: 'Invoice INV-2026-0512', orderNo: 'ORD-1007', createdAt: '2026-06-16T09:30:00Z' },
      { docType: 'statement', number: 'STMT-2026-B01', title: 'Account statement H1 2026', createdAt: '2026-07-01T06:00:00Z' },
    ],
  },
  {
    email: 'l.steiner@example.at',
    name: 'Lukas Steiner',
    company: 'Steiner & Söhne',
    password: 'demo-lukas',
    createdAt: '2025-05-02T10:00:00Z',
    orders: [
      {
        orderNo: 'ORD-1002',
        items: [
          { sku: 'HW-1002', description: 'Barcode Scanner MK II', quantity: 10, unitPriceCents: 18950 },
        ],
        events: [
          { status: 'placed', at: '2026-05-11T08:44:00Z' },
          { status: 'confirmed', at: '2026-05-11T13:15:00Z' },
          { status: 'shipped', at: '2026-05-13T09:00:00Z', note: 'Handed to carrier, 1 pallet' },
          { status: 'delivered', at: '2026-05-18T11:32:00Z' },
        ],
      },
      {
        orderNo: 'ORD-1010',
        items: [
          { sku: 'SV-3001', description: 'On-site Installation', quantity: 1, unitPriceCents: 89000 },
        ],
        events: [
          { status: 'placed', at: '2026-06-30T10:14:00Z' },
          { status: 'confirmed', at: '2026-07-02T08:40:00Z', note: 'Scheduled for calendar week 31' },
        ],
      },
      {
        orderNo: 'ORD-1016',
        items: [
          { sku: 'AC-4003', description: 'Protective Case', quantity: 10, unitPriceCents: 1990 },
        ],
        events: [
          { status: 'placed', at: '2026-07-06T15:03:00Z' },
          { status: 'cancelled', at: '2026-07-07T09:26:00Z', note: 'Cancelled on customer request — out of stock until Q4' },
        ],
      },
    ],
    documents: [
      { docType: 'invoice', number: 'INV-2026-0455', title: 'Invoice INV-2026-0455', orderNo: 'ORD-1002', createdAt: '2026-05-11T14:00:00Z' },
      { docType: 'delivery_note', number: 'DN-2026-0392', title: 'Delivery note DN-2026-0392', orderNo: 'ORD-1002', createdAt: '2026-05-13T09:00:00Z' },
      { docType: 'invoice', number: 'INV-2026-0530', title: 'Invoice INV-2026-0530', orderNo: 'ORD-1010', createdAt: '2026-07-02T09:00:00Z' },
    ],
  },
  {
    email: 'j.devries@example.nl',
    name: 'Jan de Vries',
    company: 'De Vries Handel BV',
    password: 'demo-jan',
    createdAt: '2024-09-08T10:00:00Z',
    orders: [
      {
        orderNo: 'ORD-1003',
        items: [
          { sku: 'SW-2001', description: 'Warehouse Suite License', quantity: 1, unitPriceCents: 120000 },
        ],
        events: [
          { status: 'placed', at: '2026-05-18T09:31:00Z' },
          { status: 'confirmed', at: '2026-05-18T10:05:00Z' },
          { status: 'shipped', at: '2026-05-19T08:00:00Z', note: 'License key delivered by email' },
          { status: 'delivered', at: '2026-05-19T08:01:00Z' },
        ],
      },
      {
        orderNo: 'ORD-1011',
        items: [
          { sku: 'AC-4001', description: 'Thermal Label Roll (10x)', quantity: 12, unitPriceCents: 2490 },
          { sku: 'AC-4002', description: 'Scanner Charging Dock', quantity: 2, unitPriceCents: 5900 },
        ],
        events: [
          { status: 'placed', at: '2026-07-03T09:55:00Z' },
          { status: 'confirmed', at: '2026-07-03T13:10:00Z' },
          { status: 'shipped', at: '2026-07-15T07:30:00Z', note: 'Handed to carrier' },
        ],
      },
    ],
    documents: [
      { docType: 'invoice', number: 'INV-2026-0458', title: 'Invoice INV-2026-0458', orderNo: 'ORD-1003', createdAt: '2026-05-18T11:00:00Z' },
      { docType: 'invoice', number: 'INV-2026-0540', title: 'Invoice INV-2026-0540', orderNo: 'ORD-1011', createdAt: '2026-07-03T14:00:00Z' },
      { docType: 'delivery_note', number: 'DN-2026-0421', title: 'Delivery note DN-2026-0421', orderNo: 'ORD-1011', createdAt: '2026-07-15T07:30:00Z' },
    ],
  },
];

// ── Plain-text document rendering ──────────────────────────────────────

const RULE = '─'.repeat(64);

function orderTotalCents(order: SeedOrder): number {
  return order.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

function head(kind: string, number: string, date: string): string[] {
  return [
    '0815SOFTWARE · DEMO DOCUMENT',
    RULE,
    `${kind.toUpperCase()}  ${number}`,
    `DATE      ${date.slice(0, 10)}`,
  ];
}

function itemLines(order: SeedOrder, withPrices: boolean): string[] {
  const lines = order.items.map((item) => {
    const qty = String(item.quantity).padStart(3);
    const base = `${qty}  ${item.sku.padEnd(9)} ${item.description.padEnd(30)}`;
    if (!withPrices) return base.trimEnd();
    const amount = formatMoney(item.quantity * item.unitPriceCents, CURRENCY);
    return `${base} ${amount.padStart(16)}`;
  });
  return ['QTY  SKU       DESCRIPTION', RULE, ...lines, RULE];
}

function renderDocument(doc: SeedDocument, customer: SeedCustomer, order?: SeedOrder): string {
  const address = [`BILLED TO ${customer.name}`, `          ${customer.company}`];
  const footer = [
    '',
    'Generated demo data from the MOD-01 Customer Portal seed script.',
    'Not a real commercial document.',
    '',
  ];

  switch (doc.docType) {
    case 'invoice': {
      if (!order) throw new Error(`Invoice ${doc.number} has no order`);
      return [
        ...head('Invoice', doc.number, doc.createdAt),
        `ORDER     ${order.orderNo}`,
        '',
        ...address,
        '',
        ...itemLines(order, true),
        `TOTAL ${formatMoney(orderTotalCents(order), CURRENCY).padStart(58)}`,
        '',
        'Payable within 30 days of the invoice date.',
        ...footer,
      ].join('\n');
    }
    case 'delivery_note': {
      if (!order) throw new Error(`Delivery note ${doc.number} has no order`);
      return [
        ...head('Delivery note', doc.number, doc.createdAt),
        `ORDER     ${order.orderNo}`,
        '',
        `SHIP TO   ${customer.company}`,
        '',
        ...itemLines(order, false),
        '',
        'Please report transport damage within 5 working days.',
        ...footer,
      ].join('\n');
    }
    case 'statement': {
      const rows = customer.orders.map(
        (o) =>
          `${o.orderNo}  ${o.events[0]!.at.slice(0, 10)}  ` +
          `${(o.events.at(-1)?.status ?? 'placed').padEnd(10)} ` +
          `${formatMoney(orderTotalCents(o), CURRENCY).padStart(16)}`,
      );
      return [
        ...head('Statement', doc.number, doc.createdAt),
        '',
        ...address,
        '',
        'ORDER     DATE        STATUS',
        RULE,
        ...rows,
        RULE,
        ...footer,
      ].join('\n');
    }
  }
}

// ── Seeding ────────────────────────────────────────────────────────────

/**
 * Insert the demo data set and generate its document files. Runs only
 * against an empty database (no customers); existing data is never
 * touched. The documents directory is created either way.
 */
export function seed(db: Database.Database, documentsDir: string): void {
  mkdirSync(documentsDir, { recursive: true });

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM customers').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] ${count} customers already present, skipping`);
    return;
  }

  const insertCustomer = db.prepare(
    'INSERT INTO customers (email, name, company, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertOrder = db.prepare(
    'INSERT INTO orders (customer_id, order_no, status, currency, total_cents, placed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, sku, description, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)',
  );
  const insertEvent = db.prepare(
    'INSERT INTO order_events (order_id, status, at, note) VALUES (?, ?, ?, ?)',
  );
  const insertDocument = db.prepare(
    `INSERT INTO documents (customer_id, order_id, doc_type, title, filename, stored_name, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const files: { path: string; content: string }[] = [];

  db.transaction(() => {
    for (const customer of customers) {
      const customerId = insertCustomer.run(
        customer.email,
        customer.name,
        customer.company,
        hashPassword(customer.password),
        customer.createdAt,
      ).lastInsertRowid as number;

      const orderIds = new Map<string, number>();
      for (const order of customer.orders) {
        const lastEvent = order.events.at(-1);
        const firstEvent = order.events[0];
        if (!firstEvent || !lastEvent) throw new Error(`Order ${order.orderNo} has no events`);
        const orderId = insertOrder.run(
          customerId,
          order.orderNo,
          lastEvent.status,
          CURRENCY,
          orderTotalCents(order),
          firstEvent.at,
        ).lastInsertRowid as number;
        orderIds.set(order.orderNo, orderId);
        for (const item of order.items) {
          insertItem.run(orderId, item.sku, item.description, item.quantity, item.unitPriceCents);
        }
        for (const event of order.events) {
          insertEvent.run(orderId, event.status, event.at, event.note ?? null);
        }
      }

      for (const doc of customer.documents) {
        const order = customer.orders.find((o) => o.orderNo === doc.orderNo);
        if (doc.orderNo && !order) throw new Error(`Document ${doc.number} references unknown ${doc.orderNo}`);
        const content = renderDocument(doc, customer, order);
        const filename = `${doc.number}.txt`;
        const storedName = `c${customerId}-${filename}`;
        insertDocument.run(
          customerId,
          doc.orderNo ? orderIds.get(doc.orderNo)! : null,
          doc.docType,
          doc.title,
          filename,
          storedName,
          Buffer.byteLength(content, 'utf8'),
          doc.createdAt,
        );
        files.push({ path: join(documentsDir, storedName), content });
      }
    }
  })();

  for (const file of files) writeFileSync(file.path, file.content, 'utf8');

  console.log(
    `[seed] inserted ${customers.length} customers, ` +
      `${customers.reduce((n, c) => n + c.orders.length, 0)} orders, ` +
      `${files.length} documents (files in ${documentsDir})`,
  );
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db, config.documentsDir);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
