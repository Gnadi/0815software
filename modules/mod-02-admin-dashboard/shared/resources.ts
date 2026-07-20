/**
 * Declarative resource configuration — the single place where the data
 * model is defined. Tables, forms, filters, validation and CSV exports
 * are all derived from this file. To point the dashboard at your own
 * data model, edit the `resources` array below and re-run the seed
 * script (or let the server create empty tables on first start).
 */

export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'select';

export interface FieldDef {
  /** Column name in SQLite and key in API payloads. [a-z_] only. */
  name: string;
  /** Human-readable label used in table headers and forms. */
  label: string;
  type: FieldType;
  /** Reject empty values on create/update. */
  required?: boolean;
  /** Allowed values — only for type "select". */
  options?: readonly string[];
  /** Numeric bounds — only for type "number". */
  min?: number;
  max?: number;
  /** Maximum string length — only for "text". */
  maxLength?: number;
  /** Regular expression the value must match — only for "text". */
  pattern?: string;
  /** Human hint shown when the pattern fails. */
  patternHint?: string;
  /** Hide the column in the list view (still editable in the form). */
  hideInTable?: boolean;
}

export interface ResourceDef {
  /** URL slug, SQLite table name and API path segment. [a-z_] only. */
  name: string;
  /** Plural human-readable label. */
  label: string;
  /** Short description shown under the resource title. */
  description?: string;
  fields: readonly FieldDef[];
}

export const resources: readonly ResourceDef[] = [
  {
    name: 'customers',
    label: 'Customers',
    description: 'Companies and contacts you do business with.',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 120 },
      {
        name: 'email',
        label: 'Email',
        type: 'text',
        required: true,
        maxLength: 200,
        pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
        patternHint: 'must be a valid email address',
      },
      { name: 'company', label: 'Company', type: 'text', maxLength: 120 },
      {
        name: 'country',
        label: 'Country',
        type: 'select',
        options: ['DE', 'AT', 'CH', 'FR', 'NL', 'US', 'OTHER'],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        options: ['prospect', 'active', 'inactive'],
      },
      { name: 'signed_up', label: 'Signed up', type: 'date' },
    ],
  },
  {
    name: 'products',
    label: 'Products',
    description: 'The catalogue: SKUs, pricing and stock levels.',
    fields: [
      {
        name: 'sku',
        label: 'SKU',
        type: 'text',
        required: true,
        maxLength: 32,
        pattern: '^[A-Z0-9-]+$',
        patternHint: 'uppercase letters, digits and dashes only',
      },
      { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 160 },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: ['hardware', 'software', 'service', 'accessory'],
      },
      { name: 'price', label: 'Price (EUR)', type: 'number', required: true, min: 0 },
      { name: 'stock', label: 'Stock', type: 'number', required: true, min: 0 },
      { name: 'active', label: 'Active', type: 'boolean' },
    ],
  },
  {
    name: 'orders',
    label: 'Orders',
    description: 'Incoming orders with status and totals.',
    fields: [
      {
        name: 'order_no',
        label: 'Order no.',
        type: 'text',
        required: true,
        maxLength: 20,
        pattern: '^ORD-\\d{4,}$',
        patternHint: 'format ORD-0000',
      },
      { name: 'customer', label: 'Customer', type: 'text', required: true, maxLength: 120 },
      { name: 'product', label: 'Product', type: 'text', required: true, maxLength: 160 },
      { name: 'quantity', label: 'Qty', type: 'number', required: true, min: 1 },
      { name: 'total', label: 'Total (EUR)', type: 'number', required: true, min: 0 },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        options: ['pending', 'paid', 'shipped', 'cancelled'],
      },
      { name: 'ordered_at', label: 'Ordered at', type: 'date' },
    ],
  },
];

export function getResource(name: string): ResourceDef | undefined {
  return resources.find((r) => r.name === name);
}
