import type { ModuleSummary, SummaryContext } from './summary.js';

/** The kinds of widget a board can hold. */
export const WIDGET_KINDS = ['tile', 'list', 'activity', 'launcher', 'embed'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/**
 * A widget as it is stored and as the API returns it.
 *
 * `module_id` and `widget_key` are null for the shell's own widgets (activity,
 * launcher) and set for anything fed by a peer. The pair is what survives an
 * upgrade: a module may relabel a tile freely, but changing its KEY retires the
 * widget, which is why the summary contract asks for stable keys.
 */
export interface Widget {
  id: number;
  board_id: number;
  kind: WidgetKind;
  module_id: string | null;
  widget_key: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Board {
  id: number;
  name: string;
  position: number;
  widgets: Widget[];
}

/** A widget's placement, as the client sends it after a drag or a resize. */
export interface WidgetPlacement {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The board grid. Twelve columns is the usual compromise: divisible by 2, 3, 4 and 6. */
export const GRID_COLUMNS = 12;
export const MIN_WIDGET_W = 2;
export const MIN_WIDGET_H = 1;
export const MAX_WIDGET_W = GRID_COLUMNS;
export const MAX_WIDGET_H = 8;

/** How a peer looked the last time the Workspace asked. */
export interface PeerStatus {
  id: string;
  n: string;
  label: string;
  /** Is a URL configured for it at all? */
  configured: boolean;
  /** Can it be framed and handed a session? */
  embeddable: boolean;
  /** Public origin for links and frames; null when unconfigured. */
  publicUrl: string | null;
  /** Did the last summary call succeed? Null when never attempted. */
  reachable: boolean | null;
  /** Why the last call failed, for the widget's error state. */
  problem: string | null;
}

/** One peer's summary, or the reason there isn't one. */
export type PeerSummary =
  | { ok: true; module: string; summary: ModuleSummary }
  | { ok: false; module: string; problem: string };

export interface ActivityEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  resource: string;
  /** The module the event came from, when it can be told from the resource. */
  module: string | null;
}

/** The shell's shared context, as stored and as the client sends it. */
export type ShellContext = SummaryContext & {
  /** Display name for the selected party, so the bar can show who it is. */
  party_name?: string;
};

export interface Preferences {
  active_board: number | null;
  context: ShellContext;
}
