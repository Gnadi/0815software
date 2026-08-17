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
 * Today there is one entry. That is not an oversight: MOD-13 → MOD-04 is the
 * only cross-module data path the catalogue actually has
 * (docs/CUSTOMER-MASTER-DATA.md), and a board full of buttons that turn out to
 * be aspirations is worse than a board with one that works.
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
];

/** Actions attached to a given summary list, in declaration order. */
export function actionsFor(moduleId: string, listKey: string): ActionDescriptor[] {
  return ACTIONS.filter((a) => a.sourceModule === moduleId && a.sourceList === listKey);
}

export function actionById(id: string): ActionDescriptor | undefined {
  return ACTIONS.find((a) => a.id === id);
}
