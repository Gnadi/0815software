/**
 * Pipeline configuration — THE one place the sales stages live.
 *
 * The whole app renders its pipeline from this list: the kanban board
 * columns, the stage dropdowns, the win-probability used to derive a
 * deal's expected value — all of it is read from here (served to the
 * client via `GET /api/config`). Nothing else in the codebase hardcodes
 * a stage key. Edit this file to change the pipeline.
 *
 * Rules enforced by the self-check at the bottom (fails loudly at
 * startup, never silently at runtime):
 *   - stages are ordered; `position` is their index
 *   - keys are unique, lowercase, non-empty
 *   - probabilities are integer percentages in [0, 100]
 *   - the LAST TWO stages are the terminal outcomes, in this exact
 *     order: `won` (probability 100) then `lost` (probability 0)
 *   - every non-terminal ("active") stage sits before them
 */

export interface Stage {
  /** Stable identifier stored on deals and stage events. */
  key: string;
  /** Human label rendered in the UI. */
  label: string;
  /** Default win-probability as an integer percentage, 0–100. */
  probability: number;
  /** Terminal stages (`won`, `lost`) cannot be moved out of except by an explicit reopen. */
  terminal: boolean;
}

export const WON_KEY = 'won';
export const LOST_KEY = 'lost';

export const STAGES: Stage[] = [
  { key: 'lead', label: 'Lead', probability: 10, terminal: false },
  { key: 'qualified', label: 'Qualified', probability: 30, terminal: false },
  { key: 'proposal', label: 'Proposal', probability: 55, terminal: false },
  { key: 'negotiation', label: 'Negotiation', probability: 80, terminal: false },
  { key: WON_KEY, label: 'Won', probability: 100, terminal: true },
  { key: LOST_KEY, label: 'Lost', probability: 0, terminal: true },
];

export function stageByKey(key: string): Stage | undefined {
  return STAGES.find((s) => s.key === key);
}

export function isStageKey(key: string): boolean {
  return STAGES.some((s) => s.key === key);
}

export function isTerminal(key: string): boolean {
  return stageByKey(key)?.terminal ?? false;
}

/** Ordered index of a stage key (its `position`). */
export function stagePosition(key: string): number {
  return STAGES.findIndex((s) => s.key === key);
}

/** The first stage — where a brand-new deal starts unless one is chosen. */
export function defaultStageKey(): string {
  return STAGES[0]!.key;
}

/** Active (non-terminal) stages, in order. */
export function activeStages(): Stage[] {
  return STAGES.filter((s) => !s.terminal);
}

/**
 * Expected value in integer cents: value × the stage's win-probability.
 * Derived on demand, never stored. round(value_cents × pct / 100).
 */
export function expectedValueCents(valueCents: number, stageKey: string): number {
  const stage = stageByKey(stageKey);
  if (!stage) return 0;
  return Math.round((valueCents * stage.probability) / 100);
}

// ── Config self-check (runs once at import) ──────────────────────────
{
  if (STAGES.length < 3) {
    throw new Error('pipeline-config: need at least one active stage plus the two terminal stages');
  }
  const keys = new Set<string>();
  for (const stage of STAGES) {
    if (!/^[a-z][a-z0-9_-]*$/.test(stage.key)) {
      throw new Error(`pipeline-config: invalid stage key "${stage.key}" (lowercase, starts with a letter)`);
    }
    if (keys.has(stage.key)) throw new Error(`pipeline-config: duplicate stage key "${stage.key}"`);
    keys.add(stage.key);
    if (stage.label.trim() === '') throw new Error(`pipeline-config: stage "${stage.key}" needs a label`);
    if (!Number.isInteger(stage.probability) || stage.probability < 0 || stage.probability > 100) {
      throw new Error(`pipeline-config: stage "${stage.key}" probability must be an integer 0–100`);
    }
  }
  const won = STAGES[STAGES.length - 2]!;
  const lost = STAGES[STAGES.length - 1]!;
  if (won.key !== WON_KEY || !won.terminal || won.probability !== 100) {
    throw new Error('pipeline-config: the second-to-last stage must be terminal "won" with probability 100');
  }
  if (lost.key !== LOST_KEY || !lost.terminal || lost.probability !== 0) {
    throw new Error('pipeline-config: the last stage must be terminal "lost" with probability 0');
  }
  if (STAGES.slice(0, -2).some((s) => s.terminal)) {
    throw new Error('pipeline-config: only the last two stages (won, lost) may be terminal');
  }
}
