// ─── Shared module catalogue ──────────────────────────────────────────────
// Single source of truth for the module list, consumed by:
//   • src/components/Modules.astro   (landing-page section)
//   • src/pages/modules.astro        (full catalogue page)
//   • src/pages/modules/[slug].astro (per-module live demo)
//
// `slug` is the short, human-readable demo URL segment (/modules/<slug>).
// `dir`  is the folder under /modules used for the GitHub source link.

export interface ModuleEntry {
  n: string;      // MOD-01
  slug: string;   // customer-portal
  dir: string;    // mod-01-customer-portal
  title: string;
  body: string;
  scope: string;
}

export const REPO = 'https://github.com/Gnadi/0815software';

export const modules: ModuleEntry[] = [
  { n: 'MOD-01', slug: 'customer-portal',      dir: 'mod-01-customer-portal',      title: 'Customer Portal',       scope: '3–4 WKS', body: 'Self-service access to orders, documents, and status. No account manager required.' },
  { n: 'MOD-02', slug: 'admin-dashboard',      dir: 'mod-02-admin-dashboard',      title: 'Admin Dashboard',       scope: '2–3 WKS', body: 'Internal CRUD interface over any data model. Tables, filters, bulk actions, exports.' },
  { n: 'MOD-03', slug: 'inventory-management', dir: 'mod-03-inventory-management', title: 'Inventory Management',   scope: '4–5 WKS', body: 'Stock levels, SKUs, warehouse locations, and purchase order tracking in one place.' },
  { n: 'MOD-04', slug: 'invoice-billing',      dir: 'mod-04-invoice-billing',      title: 'Invoice & Billing',      scope: '3–4 WKS', body: 'Generate, send, and track invoices. PDF export, payment status, customer ledger.' },
  { n: 'MOD-05', slug: 'employee-directory',   dir: 'mod-05-employee-directory',   title: 'Employee Directory',     scope: '2–3 WKS', body: 'Org chart, roles, contact data, and department structure. Integrates with HR onboarding.' },
  { n: 'MOD-06', slug: 'procurement-tracker',  dir: 'mod-06-procurement-tracker',  title: 'Procurement Tracker',    scope: '4–6 WKS', body: 'RFQ, purchase orders, multi-tier approval workflows. Export to any ERP CSV format.' },
  { n: 'MOD-07', slug: 'storefront',           dir: 'mod-07-storefront',           title: 'Storefront',             scope: '5–6 WKS', body: 'Product catalogue, cart, checkout, and order management. No SaaS fees, no revenue cut.' },
  { n: 'MOD-08', slug: 'reporting-suite',      dir: 'mod-08-reporting-suite',      title: 'Reporting Suite',        scope: '3–4 WKS', body: 'Scheduled exports, pivot tables, and chart embeds built on top of your existing database.' },
  { n: 'MOD-09', slug: 'document-management',  dir: 'mod-09-document-management',   title: 'Document Management',    scope: '3–4 WKS', body: 'Upload, tag, version, and control access. Matter-based or project-based access controls.' },
  { n: 'MOD-10', slug: 'crm-lite',             dir: 'mod-10-crm-lite',             title: 'CRM Lite',               scope: '3–5 WKS', body: 'Contacts, deals, activity log, and pipeline view. No AI upsells, no seat caps, no surprises.' },
  { n: 'MOD-11', slug: 'time-tracking',        dir: 'mod-11-time-tracking',        title: 'Time Tracking',          scope: '2–3 WKS', body: 'Project allocation, daily entry, and export to payroll or billing. Works offline.' },
  { n: 'MOD-12', slug: 'support-tickets',      dir: 'mod-12-support-tickets',      title: 'Support Ticket System',  scope: '3–4 WKS', body: 'Inbound queue, assignment, status tracking, and SLA timers. Email and web intake.' },
  { n: 'MOD-13', slug: 'offers',               dir: 'mod-13-offers',               title: 'Offers',                 scope: '3–4 WKS', body: 'Write, send, and track sales offers. Line-item quotes with discounts, validity dates, PDF export, and a customer acceptance link.' },
  { n: 'MOD-14', slug: 'subsidies-funds',      dir: 'mod-14-subsidies-funds',      title: 'Subsidies & Funds',      scope: '3–4 WKS', body: 'Track funding programs, applications, approvals, disbursements, and reporting deadlines. Never miss a grant deadline again.' },
];

export const sourceUrl = (dir: string) => `${REPO}/tree/main/modules/${dir}`;
export const demoUrl = (slug: string) => `/modules/${slug}`;
