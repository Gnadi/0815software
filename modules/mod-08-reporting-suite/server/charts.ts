import type { ChartConfig, QueryResult } from '../shared/types.js';
import { CHART_KINDS } from '../shared/types.js';

/**
 * Hand-rolled SVG chart rendering — no chart library, no runtime deps.
 * Bar and line charts from a report result and a {kind, x, y} config,
 * with a linear y axis using "nice" tick steps. The output is a
 * self-contained, static SVG string safe to embed in an <img> or
 * <iframe>; it inlines its own colours in the 0815 token palette so an
 * embed needs no external stylesheet.
 */

export class ChartError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const WIDTH = 720;
const HEIGHT = 360;
const M = { top: 24, right: 24, bottom: 64, left: 64 };
const PLOT_W = WIDTH - M.left - M.right;
const PLOT_H = HEIGHT - M.top - M.bottom;

const COLORS = {
  bg: '#0a0a0a',
  fg: '#e8e4dc',
  dim: '#6b675f',
  line: 'rgba(232,228,220,0.12)',
  accent: '#e8e4dc',
};

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Round a number up to a "nice" 1/2/5 × 10^k value. */
function niceNum(range: number, round: boolean): number {
  if (range === 0) return 1;
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let niceFrac: number;
  if (round) {
    niceFrac = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  } else {
    niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  }
  return niceFrac * Math.pow(10, exp);
}

/** Produce ~`count` nice ticks spanning [min,max]. */
function niceTicks(min: number, max: number, count = 5): { lo: number; hi: number; step: number; ticks: number[] } {
  const range = niceNum(max - min || 1, false);
  const step = niceNum(range / Math.max(1, count - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Guard against fp accumulation producing a runaway loop.
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 1000; v += step, i++) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return { lo, hi, step, ticks };
}

function formatTick(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

export function renderChartSvg(result: QueryResult, config: ChartConfig): string {
  if (!(CHART_KINDS as readonly string[]).includes(config.kind)) {
    throw new ChartError(422, `chart kind must be one of: ${CHART_KINDS.join(', ')}`);
  }
  if (!result.columns.includes(config.x)) {
    throw new ChartError(422, `x column "${config.x}" is not in the report result`);
  }
  if (!result.columns.includes(config.y)) {
    throw new ChartError(422, `y column "${config.y}" is not in the report result`);
  }

  const points = result.rows.map((r) => ({
    label: r[config.x] === null || r[config.x] === undefined ? '∅' : String(r[config.x]),
    value: toNumber(r[config.y]),
  }));

  const values = points.map((p) => p.value);
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : 1;
  const { lo, hi, ticks } = niceTicks(Math.min(0, dataMin), Math.max(0, dataMax, dataMin === dataMax ? dataMin + 1 : dataMax));
  const span = hi - lo || 1;

  const yOf = (v: number): number => M.top + PLOT_H - ((v - lo) / span) * PLOT_H;
  const n = points.length;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(config.kind)} chart">`,
  );
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>`);

  // ── Y grid + tick labels ─────────────────────────────────────────────
  for (const t of ticks) {
    const y = yOf(t);
    parts.push(
      `<line x1="${M.left}" y1="${y.toFixed(2)}" x2="${M.left + PLOT_W}" y2="${y.toFixed(2)}" stroke="${COLORS.line}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${M.left - 8}" y="${(y + 3).toFixed(2)}" fill="${COLORS.dim}" font-family="monospace" font-size="10" text-anchor="end">${esc(formatTick(t))}</text>`,
    );
  }

  // ── Axes ─────────────────────────────────────────────────────────────
  const baseY = yOf(Math.max(lo, Math.min(hi, 0)));
  parts.push(
    `<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + PLOT_H}" stroke="${COLORS.line}" stroke-width="1"/>`,
  );
  parts.push(
    `<line x1="${M.left}" y1="${(M.top + PLOT_H).toFixed(2)}" x2="${M.left + PLOT_W}" y2="${(M.top + PLOT_H).toFixed(2)}" stroke="${COLORS.line}" stroke-width="1"/>`,
  );

  // ── Marks ────────────────────────────────────────────────────────────
  if (config.kind === 'bar') {
    const slot = n > 0 ? PLOT_W / n : PLOT_W;
    const barW = Math.max(1, slot * 0.62);
    points.forEach((p, i) => {
      const cx = M.left + slot * (i + 0.5);
      const y = yOf(p.value);
      const top = Math.min(y, baseY);
      const h = Math.abs(baseY - y);
      parts.push(
        `<rect x="${(cx - barW / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${COLORS.accent}"/>`,
      );
    });
  } else {
    const slot = n > 1 ? PLOT_W / (n - 1) : PLOT_W;
    const coords = points.map((p, i) => {
      const cx = n > 1 ? M.left + slot * i : M.left + PLOT_W / 2;
      return { x: cx, y: yOf(p.value) };
    });
    if (coords.length > 0) {
      const d = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
      parts.push(`<polyline points="${d}" fill="none" stroke="${COLORS.accent}" stroke-width="2"/>`);
      coords.forEach((c) => {
        parts.push(`<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="3" fill="${COLORS.accent}"/>`);
      });
    }
  }

  // ── X labels (thinned so they don't overlap) ─────────────────────────
  const maxLabels = 12;
  const stepEvery = Math.max(1, Math.ceil(n / maxLabels));
  const slot = config.kind === 'bar' ? (n > 0 ? PLOT_W / n : PLOT_W) : n > 1 ? PLOT_W / (n - 1) : PLOT_W;
  points.forEach((p, i) => {
    if (i % stepEvery !== 0) return;
    const cx =
      config.kind === 'bar'
        ? M.left + slot * (i + 0.5)
        : n > 1
          ? M.left + slot * i
          : M.left + PLOT_W / 2;
    const label = p.label.length > 12 ? p.label.slice(0, 11) + '…' : p.label;
    parts.push(
      `<text x="${cx.toFixed(2)}" y="${(M.top + PLOT_H + 16).toFixed(2)}" fill="${COLORS.dim}" font-family="monospace" font-size="10" text-anchor="middle">${esc(label)}</text>`,
    );
  });

  parts.push(`</svg>`);
  return parts.join('');
}
