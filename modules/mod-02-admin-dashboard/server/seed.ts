import type Database from 'better-sqlite3';
import { resources } from '../shared/resources.js';

const seedData: Record<string, Record<string, string | number>[]> = {
  customers: [
    { name: 'Anna Berger', email: 'anna.berger@example.de', company: 'Berger Logistik GmbH', country: 'DE', status: 'active', signed_up: '2025-03-14' },
    { name: 'Lukas Steiner', email: 'l.steiner@example.at', company: 'Steiner & Söhne', country: 'AT', status: 'active', signed_up: '2025-05-02' },
    { name: 'Marie Dupont', email: 'marie.dupont@example.fr', company: 'Dupont SARL', country: 'FR', status: 'prospect', signed_up: '2025-11-20' },
    { name: 'Jan de Vries', email: 'j.devries@example.nl', company: 'De Vries Handel BV', country: 'NL', status: 'active', signed_up: '2024-09-08' },
    { name: 'Sophie Keller', email: 'sophie.keller@example.ch', company: 'Keller Präzision AG', country: 'CH', status: 'inactive', signed_up: '2023-12-01' },
    { name: 'Tom Fischer', email: 'tom.fischer@example.de', company: 'Fischer Metallbau', country: 'DE', status: 'active', signed_up: '2025-01-27' },
    { name: 'Elena Novak', email: 'elena.novak@example.com', company: 'Novak Consulting', country: 'OTHER', status: 'prospect', signed_up: '2026-02-11' },
    { name: 'David Miller', email: 'd.miller@example.com', company: 'Miller Industries', country: 'US', status: 'active', signed_up: '2024-06-30' },
    { name: 'Clara Hoffmann', email: 'clara.hoffmann@example.de', company: 'Hoffmann Bäckerei', country: 'DE', status: 'inactive', signed_up: '2023-04-19' },
    { name: 'Peter Gruber', email: 'p.gruber@example.at', company: 'Gruber Transporte', country: 'AT', status: 'active', signed_up: '2025-08-15' },
    { name: 'Nina Weber', email: 'nina.weber@example.de', company: 'Weber IT Services', country: 'DE', status: 'prospect', signed_up: '2026-05-03' },
    { name: 'Erik Johansson', email: 'erik.j@example.com', company: 'Johansson AB', country: 'OTHER', status: 'active', signed_up: '2025-10-22' },
  ],
  products: [
    { sku: 'HW-1001', name: 'Industrial Label Printer', category: 'hardware', price: 649.0, stock: 34, active: 1 },
    { sku: 'HW-1002', name: 'Barcode Scanner MK II', category: 'hardware', price: 189.5, stock: 120, active: 1 },
    { sku: 'SW-2001', name: 'Warehouse Suite License', category: 'software', price: 1200.0, stock: 999, active: 1 },
    { sku: 'SW-2002', name: 'Reporting Add-on', category: 'software', price: 340.0, stock: 999, active: 1 },
    { sku: 'SV-3001', name: 'On-site Installation', category: 'service', price: 890.0, stock: 0, active: 1 },
    { sku: 'SV-3002', name: 'Annual Maintenance', category: 'service', price: 1450.0, stock: 0, active: 1 },
    { sku: 'AC-4001', name: 'Thermal Label Roll (10x)', category: 'accessory', price: 24.9, stock: 830, active: 1 },
    { sku: 'AC-4002', name: 'Scanner Charging Dock', category: 'accessory', price: 59.0, stock: 66, active: 1 },
    { sku: 'HW-1003', name: 'Rugged Handheld Terminal', category: 'hardware', price: 980.0, stock: 12, active: 0 },
    { sku: 'AC-4003', name: 'Protective Case', category: 'accessory', price: 19.9, stock: 0, active: 0 },
  ],
  orders: [
    { order_no: 'ORD-1001', customer: 'Berger Logistik GmbH', product: 'Industrial Label Printer', quantity: 2, total: 1298.0, status: 'shipped', ordered_at: '2026-05-04' },
    { order_no: 'ORD-1002', customer: 'Steiner & Söhne', product: 'Barcode Scanner MK II', quantity: 10, total: 1895.0, status: 'paid', ordered_at: '2026-05-11' },
    { order_no: 'ORD-1003', customer: 'De Vries Handel BV', product: 'Warehouse Suite License', quantity: 1, total: 1200.0, status: 'shipped', ordered_at: '2026-05-18' },
    { order_no: 'ORD-1004', customer: 'Fischer Metallbau', product: 'Thermal Label Roll (10x)', quantity: 40, total: 996.0, status: 'paid', ordered_at: '2026-05-27' },
    { order_no: 'ORD-1005', customer: 'Miller Industries', product: 'Rugged Handheld Terminal', quantity: 4, total: 3920.0, status: 'pending', ordered_at: '2026-06-02' },
    { order_no: 'ORD-1006', customer: 'Gruber Transporte', product: 'Scanner Charging Dock', quantity: 6, total: 354.0, status: 'shipped', ordered_at: '2026-06-09' },
    { order_no: 'ORD-1007', customer: 'Berger Logistik GmbH', product: 'Annual Maintenance', quantity: 1, total: 1450.0, status: 'paid', ordered_at: '2026-06-15' },
    { order_no: 'ORD-1008', customer: 'Weber IT Services', product: 'Reporting Add-on', quantity: 2, total: 680.0, status: 'pending', ordered_at: '2026-06-21' },
    { order_no: 'ORD-1009', customer: 'Johansson AB', product: 'Barcode Scanner MK II', quantity: 25, total: 4737.5, status: 'cancelled', ordered_at: '2026-06-24' },
    { order_no: 'ORD-1010', customer: 'Steiner & Söhne', product: 'On-site Installation', quantity: 1, total: 890.0, status: 'paid', ordered_at: '2026-06-30' },
    { order_no: 'ORD-1011', customer: 'De Vries Handel BV', product: 'Thermal Label Roll (10x)', quantity: 12, total: 298.8, status: 'shipped', ordered_at: '2026-07-03' },
    { order_no: 'ORD-1012', customer: 'Fischer Metallbau', product: 'Protective Case', quantity: 30, total: 597.0, status: 'pending', ordered_at: '2026-07-08' },
    { order_no: 'ORD-1013', customer: 'Miller Industries', product: 'Warehouse Suite License', quantity: 3, total: 3600.0, status: 'paid', ordered_at: '2026-07-11' },
    { order_no: 'ORD-1014', customer: 'Novak Consulting', product: 'Reporting Add-on', quantity: 1, total: 340.0, status: 'pending', ordered_at: '2026-07-14' },
  ],
};

/** Insert example rows into every table that is currently empty. */
export function seed(db: Database.Database): void {
  for (const resource of resources) {
    const rows = seedData[resource.name];
    if (!rows) continue;
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM "${resource.name}"`).get() as {
      count: number;
    };
    if (count > 0) {
      console.log(`[seed] ${resource.name}: ${count} rows already present, skipping`);
      continue;
    }
    const columns = resource.fields.map((f) => f.name);
    const insert = db.prepare(
      `INSERT INTO "${resource.name}" (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${columns.map(() => '?').join(',')})`,
    );
    const insertAll = db.transaction((items: Record<string, string | number>[]) => {
      for (const item of items) insert.run(...columns.map((c) => item[c] ?? null));
    });
    insertAll(rows);
    console.log(`[seed] ${resource.name}: inserted ${rows.length} rows`);
  }
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
