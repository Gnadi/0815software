# Business Modules

**This directory contains Business Modules only** — complete,
customer-facing applications that each solve an end-user problem on their
own. It holds no shared backend services; those live in the
[Platform Services catalog](../platform/README.md), and modules consume
them over APIs. The two catalogs are independent (see the
[architecture overview](../README.md#architecture)).

The 0815software module catalogue: fourteen standard modules for standard
business problems, each shipped MIT-licensed with full source code. This
directory holds the implementations. **All fourteen modules are now
available**: MOD-01 Customer Portal, MOD-02 Admin Dashboard, MOD-03 Inventory
Management, MOD-04 Invoice & Billing, MOD-05 Employee Directory, MOD-06
Procurement Tracker, MOD-07 Storefront, MOD-08 Reporting Suite, MOD-09
Document Management, MOD-10 CRM Lite, MOD-11 Time Tracking, MOD-12 Support
Ticket System, MOD-13 Offers and MOD-14 Subsidies & Funds. See the
[catalogue page](https://0815software.com/modules) for scopes and
descriptions.

| #      | Module                | Status      | Source                                             |
| ------ | --------------------- | ----------- | -------------------------------------------------- |
| MOD-01 | Customer Portal       | **Available** | [mod-01-customer-portal](./mod-01-customer-portal) |
| MOD-02 | Admin Dashboard       | **Available** | [mod-02-admin-dashboard](./mod-02-admin-dashboard) |
| MOD-03 | Inventory Management  | **Available** | [mod-03-inventory-management](./mod-03-inventory-management) |
| MOD-04 | Invoice & Billing     | **Available** | [mod-04-invoice-billing](./mod-04-invoice-billing) |
| MOD-05 | Employee Directory    | **Available** | [mod-05-employee-directory](./mod-05-employee-directory) |
| MOD-06 | Procurement Tracker   | **Available** | [mod-06-procurement-tracker](./mod-06-procurement-tracker) |
| MOD-07 | Storefront            | **Available** | [mod-07-storefront](./mod-07-storefront) |
| MOD-08 | Reporting Suite       | **Available** | [mod-08-reporting-suite](./mod-08-reporting-suite) |
| MOD-09 | Document Management   | **Available** | [mod-09-document-management](./mod-09-document-management) |
| MOD-10 | CRM Lite              | **Available** | [mod-10-crm-lite](./mod-10-crm-lite) |
| MOD-11 | Time Tracking         | **Available** | [mod-11-time-tracking](./mod-11-time-tracking) |
| MOD-12 | Support Ticket System | **Available** | [mod-12-support-tickets](./mod-12-support-tickets) |
| MOD-13 | Offers                | **Available** | [mod-13-offers](./mod-13-offers) |
| MOD-14 | Subsidies & Funds     | **Available** | [mod-14-subsidies-funds](./mod-14-subsidies-funds) |

Each module is a self-contained application with its own `package.json`,
`LICENSE` and README — install and run it independently of this repository.
