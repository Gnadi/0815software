/**
 * A pane as it is stored and as the API returns it.
 *
 * There is exactly one kind, and that is the whole point of this module: a
 * pane is a WHOLE MODULE in a frame. `module_id` is therefore never null —
 * unlike the Workspace's widgets, which can be the shell's own — because a
 * pane with no module would be an empty rectangle, and an empty rectangle is
 * not a thing anyone wants on a screen.
 */
export interface Pane {
  id: number;
  board_id: number;
  module_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Board {
  id: number;
  name: string;
  position: number;
  panes: Pane[];
}

/** A pane's placement, as the client sends it after a drag or a resize. */
export interface PanePlacement {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The board grid. Twelve columns is the usual compromise: divisible by 2, 3, 4
 * and 6, so halves, thirds and quarters are all expressible.
 *
 * The minimum is larger than the Workspace's, and deliberately: a widget can
 * usefully be two columns wide because it holds one figure, whereas a pane
 * holds a whole application — its own navigation, its own tables — and anything
 * narrower than a quarter of the screen renders that unusable rather than
 * merely small.
 */
export const GRID_COLUMNS = 12;
export const MIN_PANE_W = 3;
export const MIN_PANE_H = 3;
export const MAX_PANE_W = GRID_COLUMNS;
export const MAX_PANE_H = 12;

/** How a peer looks to this module. */
export interface PeerStatus {
  id: string;
  n: string;
  label: string;
  /** Is an internal URL configured for it at all? */
  configured: boolean;
  /** Does it declare itself framable, and is a public origin known for it? */
  embeddable: boolean;
  /** Public origin the browser must use for the frame; null when unconfigured. */
  publicUrl: string | null;
}

export interface Preferences {
  active_board: number | null;
}
