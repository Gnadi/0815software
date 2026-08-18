/**
 * CROSS-MODULE ACTIONS — the buttons the board can put on a summary item.
 *
 * An action takes something one module owns and hands it to another, without
 * either module's UI being opened. It is declarative on purpose: an entry names
 * a source list, a target module and a route that ALREADY EXISTS there, so
 * adding one is a data change rather than new endpoints on both sides.
 *
 * Two rules keep this catalogue honest, and both are enforced by tests:
 *
 * 1. **Only real routes.** An entry is added when the target module already
 *    serves that path for its own UI. The Workspace never asks a module to
 *    grow an endpoint for the shell's benefit — that is what makes every
 *    module still work, and still ship, on its own.
 * 2. **Run as the person, never as the machine.** The Workspace calls the
 *    target with a session it obtained through that module's handoff for
 *    whoever clicked (`server/sessions.ts`), so the target authorizes and
 *    records the action exactly as it would from its own screens. The machine
 *    token opens summaries and mints sessions; it never performs writes.
 *
 * The three entries are the sales chain the catalogue actually has, in order:
 *
 *     MOD-10 deal ──QUOTE──▶ MOD-13 offer ──BILL──▶ MOD-04 invoice
 *                                  │
 *                                  └────PLAN────▶ MOD-11 project
 *
 * Each arrow is a real endpoint on the target, with its own suite on both
 * sides. What is deliberately absent is the diagonal: there is no button from a
 * deal to an invoice, because the module that owns invoices refuses to bill a
 * deal (`transfer-import.ts`), and none from a deal to a project, because
 * staffing work nobody has bought is how a team books hours against a job that
 * never happens. A board full of buttons that turn out to be aspirations is
 * worse than a board with three that work.
 *
 * One limit worth stating: an action is offered when BOTH ends are in this
 * stack, which is what the Workspace can see. It cannot see whether the target
 * was told about the source — MOD-13 needs `CRM_URL` to fetch the deal back,
 * MOD-04 needs `OFFERS_URL`, MOD-11 needs `OFFERS_URL`. `deploy/provision.mjs`
 * sets all of them from the registry's peer declarations, so a provisioned
 * stack is never in that state; a hand-wired one that is gets the target's own
 * 501 ("set CRM_URL to quote deals from MOD-10"), passed through verbatim,
 * which names the missing variable and the module to set it on.
 */

export interface ActionDescriptor {
  /** Stable id — what the UI posts back to /api/actions/:id. */
  id: string;
  /** Button text on the item. */
  label: string;
  /** Present tense, shown while it runs. */
  activeLabel: string;
  /** The module whose summary list this action attaches to. */
  sourceModule: string;
  /** The list key within that summary. */
  sourceList: string;
  /** The module the call goes to. */
  targetModule: string;
  /** Path on the target, which must be one of its existing routes. */
  path: string;
  method: 'POST';
  /**
   * The request body, built from the summary item's `id`. Kept as a function of
   * one string because that is all an item carries — an action that needed more
   * would be reaching into a module's internals, which is the coupling the
   * summary contract exists to prevent.
   */
  body: (itemId: string) => Record<string, unknown>;
  /** What the board says when it worked. `{id}` is replaced with the item id. */
  success: string;
}

export const ACTIONS: readonly ActionDescriptor[] = [
  {
    id: 'bill-offer',
    label: 'BILL THIS',
    activeLabel: 'BILLING…',
    sourceModule: 'mod-13-offers',
    sourceList: 'accepted_offers',
    targetModule: 'mod-04-invoice-billing',
    // MOD-04's own IMPORT OFFER button posts here. It is idempotent on the
    // offer number, so a double click finds the first invoice rather than
    // creating a second one — which is why the board needs no state of its own.
    path: '/api/invoices/import-offer',
    method: 'POST',
    body: (offerNumber) => ({ offer_number: offerNumber }),
    success: 'Billed {id} — draft invoice created',
  },
  {
    id: 'quote-deal',
    label: 'QUOTE THIS',
    activeLabel: 'QUOTING…',
    sourceModule: 'mod-10-crm-lite',
    // Open deals only — the list `top_deals` holds. MOD-10 refuses to export a
    // won or lost one anyway, so a button on a terminal deal could only fail.
    sourceList: 'top_deals',
    targetModule: 'mod-13-offers',
    // MOD-13 fetches the deal back over CRM_URL and produces a DRAFT. Nothing
    // is sent and nothing is numbered: a deal is an estimate, and turning it
    // into a document is still the quoting person's job.
    path: '/api/offers/import-deal',
    method: 'POST',
    // The item id of a deal in MOD-10's summary is its primary key.
    body: (dealId) => ({ deal_id: dealId }),
    success: 'Quoted deal {id} — draft offer created',
  },
  {
    id: 'plan-offer',
    label: 'PLAN WORK',
    activeLabel: 'PLANNING…',
    sourceModule: 'mod-13-offers',
    // The same list BILL THIS sits on. An accepted offer is usually both
    // things at once — something to invoice and something to do — and the two
    // buttons are independent: neither is a step towards the other, and doing
    // one first is a matter of how a business runs, not of what is allowed.
    sourceList: 'accepted_offers',
    targetModule: 'mod-11-time-tracking',
    // MOD-11 creates a project with one task per offer line and no rate — see
    // its transfer-import.ts for why the money deliberately stays behind.
    path: '/api/projects/import-offer',
    method: 'POST',
    body: (offerNumber) => ({ offer_number: offerNumber }),
    success: 'Planned {id} — project created for time tracking',
  },
];

/** Actions attached to a given summary list, in declaration order. */
export function actionsFor(moduleId: string, listKey: string): ActionDescriptor[] {
  return ACTIONS.filter((a) => a.sourceModule === moduleId && a.sourceList === listKey);
}

export function actionById(id: string): ActionDescriptor | undefined {
  return ACTIONS.find((a) => a.id === id);
}
