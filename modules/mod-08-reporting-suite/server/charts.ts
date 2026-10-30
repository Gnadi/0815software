import type { ChartConfig, QueryResult } from '../shared/types.js';
import { CHART_KINDS } from '../shared/types.js';

/**
 * Hand-rolled SVG chart rendering — no chart library, no runtime deps.
 * From a report result and a config: bar, line and area charts with a linear
 * y axis using "nice" tick steps, and pie (donut) charts. A series column
 * splits the data into several series — bars side by side or stacked, one
 * line or area each — with a legend. The output is a self-contained, static
 * SVG string safe to embed in an <img> or <iframe>; it inlines its own
 * colours in the 0815 token palette so an embed needs no external stylesheet,
 * and each mark carries a <title>, so hovering shows its value.
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

const COLORS = {
  bg: '#0a0a0a',
  fg: '#e8e4dc',
  dim: '#6b675f',
  line: 'rgba(232,228,220,0.12)',
  accent: '#e8e4dc',
};

/**
 * Series colours: the accent first (a one-series chart looks as it always
 * did), then hues muted to sit on the dark background and tell apart.
 * "Other" — everything past the eighth series or slice — is grey.
 */
const SERIES_COLORS = ['#e8e4dc', '#c08b8b', '#8ab89a', '#d9c07a', '#7aa2d9', '#b08bc0', '#d98a7a', '#7ac0b8'];
const OTHER_COLOR = '#6b675f';
const MAX_SERIES = SERIES_COLORS.length;

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

const labelOf = (value: unknown): string => (value === null || value === undefined ? '∅' : String(value));

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

const fmt = (n: number): string => n.toFixed(2);

// ── The data, shaped for drawing ─────────────────────────────────────

interface Series {
  name: string;
  color: string;
  /** One value per category; null where the series has no row. */
  values: (number | null)[];
}

interface Shaped {
  categories: string[];
  series: Series[];
}

/**
 * One series: a point per row, in row order, as charts always drew. Several
 * (a series column): categories are the distinct x values and each cell sums
 * the rows that share its x and series — past the eighth series, the rest are
 * summed into "Other".
 */
function shape(result: QueryResult, config: ChartConfig): Shaped {
  const series = config.series ?? null;
  if (series === null) {
    return {
      categories: result.rows.map((r) => labelOf(r[config.x])),
      series: [{ name: config.y, color: SERIES_COLORS[0]!, values: result.rows.map((r) => toNumber(r[config.y])) }],
    };
  }
  const categories: string[] = [];
  const names: string[] = [];
  const cells = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const r of result.rows) {
    const x = labelOf(r[config.x]);
    const s = labelOf(r[series]);
    const v = toNumber(r[config.y]);
    if (!categories.includes(x)) categories.push(x);
    if (!names.includes(s)) names.push(s);
    const row = cells.get(s) ?? new Map<string, number>();
    row.set(x, (row.get(x) ?? 0) + v);
    cells.set(s, row);
    totals.set(s, (totals.get(s) ?? 0) + Math.abs(v));
  }
  let kept = names;
  let rest: string[] = [];
  if (names.length > MAX_SERIES) {
    const byWeight = [...names].sort((a, b) => totals.get(b)! - totals.get(a)!);
    const keep = new Set(byWeight.slice(0, MAX_SERIES - 1));
    kept = names.filter((n) => keep.has(n));
    rest = names.filter((n) => !keep.has(n));
  }
  const out: Series[] = kept.map((name, i) => ({ name, color: SERIES_COLORS[i]!, values: categories.map((c) => cells.get(name)!.get(c) ?? null) }));
  if (rest.length > 0) {
    out.push({
      name: `Other (${rest.length})`,
      color: OTHER_COLOR,
      values: categories.map((c) => {
        const vs = rest.map((n) => cells.get(n)!.get(c)).filter((v): v is number => v !== undefined);
        return vs.length > 0 ? vs.reduce((a, b) => a + b, 0) : null;
      }),
    });
  }
  return { categories, series: out };
}

function legend(items: { name: string; color: string }[], x: number, y: number, maxWidth: number): string {
  const parts: string[] = [];
  let cx = x;
  let cy = y;
  for (const item of items) {
    const label = item.name.length > 18 ? `${item.name.slice(0, 17)}…` : item.name;
    const w = 14 + label.length * 6.2 + 14;
    if (cx + w > x + maxWidth && cx > x) {
      cx = x;
      cy += 14;
    }
    parts.push(`<rect x="${fmt(cx)}" y="${fmt(cy - 8)}" width="9" height="9" fill="${item.color}"/>`);
    parts.push(`<text x="${fmt(cx + 13)}" y="${fmt(cy)}" fill="${COLORS.dim}" font-family="monospace" font-size="10">${esc(label)}</text>`);
    cx += w;
  }
  return parts.join('');
}

function svgOpen(kind: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(kind)} chart"><rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>`;
}

function requireColumn(result: QueryResult, column: string, role: string): void {
  if (!result.columns.includes(column)) throw new ChartError(422, `${role} column "${column}" is not in the report result`);
}

export function renderChartSvg(result: QueryResult, config: ChartConfig): string {
  if (!(CHART_KINDS as readonly string[]).includes(config.kind)) {
    throw new ChartError(422, `chart kind must be one of: ${CHART_KINDS.join(', ')}`);
  }
  requireColumn(result, config.x, 'x');
  requireColumn(result, config.y, 'y');
  if (config.series) {
    if (config.kind === 'pie') throw new ChartError(422, 'a pie chart has no series — its slices are the x column');
    requireColumn(result, config.series, 'series');
  }
  return config.kind === 'pie' ? renderPie(result, config) : renderXy(result, config);
}

// ── Bar, line, area ──────────────────────────────────────────────────

function renderXy(result: QueryResult, config: ChartConfig): string {
  const { categories, series } = shape(result, config);
  const multi = config.series != null;
  const stacked = multi && config.stacked === true && config.kind !== 'line';
  const top = multi ? 44 : M.top;
  const plotH = HEIGHT - top - M.bottom;
  const n = categories.length;

  // The y range: every value, or for stacks the tallest stack up and down.
  let dataMin = 0;
  let dataMax = 0;
  if (stacked) {
    for (let c = 0; c < n; c++) {
      let up = 0;
      let down = 0;
      for (const s of series) {
        const v = s.values[c] ?? 0;
        if (v >= 0) up += v;
        else down += v;
      }
      dataMax = Math.max(dataMax, up);
      dataMin = Math.min(dataMin, down);
    }
  } else {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    dataMin = all.length ? Math.min(0, ...all) : 0;
    dataMax = all.length ? Math.max(0, ...all) : 1;
  }
  const { lo, hi, ticks } = niceTicks(dataMin, dataMax === dataMin ? dataMin + 1 : dataMax);
  const span = hi - lo || 1;
  const yOf = (v: number): number => top + plotH - ((v - lo) / span) * plotH;
  const baseY = yOf(Math.max(lo, Math.min(hi, 0)));

  const parts: string[] = [svgOpen(config.kind)];
  for (const t of ticks) {
    const y = yOf(t);
    parts.push(`<line x1="${M.left}" y1="${fmt(y)}" x2="${M.left + PLOT_W}" y2="${fmt(y)}" stroke="${COLORS.line}" stroke-width="1"/>`);
    parts.push(`<text x="${M.left - 8}" y="${fmt(y + 3)}" fill="${COLORS.dim}" font-family="monospace" font-size="10" text-anchor="end">${esc(formatTick(t))}</text>`);
  }
  parts.push(`<line x1="${M.left}" y1="${top}" x2="${M.left}" y2="${top + plotH}" stroke="${COLORS.line}" stroke-width="1"/>`);
  parts.push(`<line x1="${M.left}" y1="${fmt(top + plotH)}" x2="${M.left + PLOT_W}" y2="${fmt(top + plotH)}" stroke="${COLORS.line}" stroke-width="1"/>`);

  const tip = (s: Series, c: number, v: number): string => `<title>${esc(`${multi ? `${s.name} · ` : ''}${categories[c]}: ${formatTick(v)}`)}</title>`;
  const isBar = config.kind === 'bar';
  const slot = isBar ? (n > 0 ? PLOT_W / n : PLOT_W) : n > 1 ? PLOT_W / (n - 1) : PLOT_W;
  const xAt = (c: number): number => (isBar ? M.left + slot * (c + 0.5) : n > 1 ? M.left + slot * c : M.left + PLOT_W / 2);

  if (isBar) {
    const groupW = Math.max(1, slot * 0.62);
    if (stacked) {
      for (let c = 0; c < n; c++) {
        let up = 0;
        let down = 0;
        for (const s of series) {
          const v = s.values[c];
          if (v === null || v === 0) continue;
          const from = v > 0 ? up : down;
          const to = from + v;
          if (v > 0) up = to;
          else down = to;
          const y1 = yOf(Math.max(from, to));
          const y2 = yOf(Math.min(from, to));
          parts.push(`<rect x="${fmt(xAt(c) - groupW / 2)}" y="${fmt(y1)}" width="${fmt(groupW)}" height="${fmt(y2 - y1)}" fill="${s.color}">${tip(s, c, v)}</rect>`);
        }
      }
    } else {
      const barW = groupW / series.length;
      series.forEach((s, si) => {
        s.values.forEach((v, c) => {
          if (v === null) return;
          const y = yOf(v);
          const x = xAt(c) - groupW / 2 + barW * si;
          parts.push(`<rect x="${fmt(x)}" y="${fmt(Math.min(y, baseY))}" width="${fmt(Math.max(1, barW - (series.length > 1 ? 1 : 0)))}" height="${fmt(Math.abs(baseY - y))}" fill="${s.color}">${tip(s, c, v)}</rect>`);
        });
      });
    }
  } else {
    // Lines and areas: a missing cell breaks the line rather than drawing it
    // through zero; a stacked area runs on the running total.
    const running = new Array<number>(n).fill(0);
    series.forEach((s) => {
      const lower = [...running];
      const pointsOf = (c: number): { x: number; y: number } | null => {
        const v = s.values[c];
        if (v === null) return null;
        const value = stacked ? running[c]! + v : v;
        return { x: xAt(c), y: yOf(value) };
      };
      const coords = categories.map((_, c) => pointsOf(c));
      if (stacked) s.values.forEach((v, c) => (running[c]! += v ?? 0));
      const runs: { x: number; y: number; c: number }[][] = [];
      let current: { x: number; y: number; c: number }[] = [];
      coords.forEach((p, c) => {
        if (p) current.push({ ...p, c });
        else if (current.length) {
          runs.push(current);
          current = [];
        }
      });
      if (current.length) runs.push(current);
      for (const run of runs) {
        if (config.kind === 'area') {
          const floor = run.map((p) => ({ x: p.x, y: stacked ? yOf(lower[p.c]!) : baseY })).reverse();
          const poly = [...run, ...floor].map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
          parts.push(`<polygon points="${poly}" fill="${s.color}" fill-opacity="${stacked ? 0.55 : 0.22}" stroke="none"/>`);
        }
        parts.push(`<polyline points="${run.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2"/>`);
        for (const p of run) parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="3" fill="${s.color}">${tip(s, p.c, s.values[p.c]!)}</circle>`);
      }
    });
  }

  // X labels, thinned so they don't overlap.
  const stepEvery = Math.max(1, Math.ceil(n / 12));
  categories.forEach((label, c) => {
    if (c % stepEvery !== 0) return;
    const text = label.length > 12 ? `${label.slice(0, 11)}…` : label;
    parts.push(`<text x="${fmt(xAt(c))}" y="${fmt(top + plotH + 16)}" fill="${COLORS.dim}" font-family="monospace" font-size="10" text-anchor="middle">${esc(text)}</text>`);
  });
  if (multi) parts.push(legend(series, M.left, 18, PLOT_W));
  parts.push('</svg>');
  return parts.join('');
}

// ── Pie (donut) ──────────────────────────────────────────────────────

function renderPie(result: QueryResult, config: ChartConfig): string {
  // Slices: the y values summed by x label. A share of a whole has no
  // negative part, so zero and negative values are left out — and the chart
  // says how many.
  const sums = new Map<string, number>();
  let left = 0;
  for (const r of result.rows) {
    const v = toNumber(r[config.y]);
    if (v <= 0) {
      left++;
      continue;
    }
    const k = labelOf(r[config.x]);
    sums.set(k, (sums.get(k) ?? 0) + v);
  }
  let slices = [...sums.entries()].map(([name, value]) => ({ name, value }));
  let hasOther = false;
  if (slices.length > MAX_SERIES) {
    hasOther = true;
    const sorted = [...slices].sort((a, b) => b.value - a.value);
    const rest = sorted.slice(MAX_SERIES - 1);
    slices = [...sorted.slice(0, MAX_SERIES - 1), { name: `Other (${rest.length})`, value: rest.reduce((a, s) => a + s.value, 0) }];
  }
  const total = slices.reduce((a, s) => a + s.value, 0);
  const colored = slices.map((s, i) => ({ ...s, color: hasOther && i === slices.length - 1 ? OTHER_COLOR : SERIES_COLORS[i]! }));

  const cx = 200;
  const cy = HEIGHT / 2;
  const R = 130;
  const r = 72;
  const parts: string[] = [svgOpen('pie')];
  if (total <= 0) {
    parts.push(`<text x="${WIDTH / 2}" y="${cy}" fill="${COLORS.dim}" font-family="monospace" font-size="12" text-anchor="middle">no positive values to show</text></svg>`);
    return parts.join('');
  }
  const point = (radius: number, angle: number) => ({ x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) });
  let angle = 0;
  for (const s of colored) {
    const share = s.value / total;
    const tip = `<title>${esc(`${s.name}: ${formatTick(s.value)} (${(share * 100).toFixed(1)} %)`)}</title>`;
    if (share >= 0.9999) {
      // One slice is the whole ring; an arc from a point to itself draws nothing.
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${s.color}" stroke-width="${R - r}">${tip}</circle>`);
      break;
    }
    const end = angle + share * 2 * Math.PI;
    const large = share > 0.5 ? 1 : 0;
    const a = point(R, angle);
    const b = point(R, end);
    const c = point(r, end);
    const d = point(r, angle);
    parts.push(
      `<path d="M${fmt(a.x)},${fmt(a.y)} A${R},${R} 0 ${large} 1 ${fmt(b.x)},${fmt(b.y)} L${fmt(c.x)},${fmt(c.y)} A${r},${r} 0 ${large} 0 ${fmt(d.x)},${fmt(d.y)} Z" fill="${s.color}" stroke="${COLORS.bg}" stroke-width="1">${tip}</path>`,
    );
    angle = end;
  }
  parts.push(`<text x="${cx}" y="${cy + 4}" fill="${COLORS.fg}" font-family="monospace" font-size="13" text-anchor="middle">${esc(formatTick(total))}</text>`);
  // The legend lists each slice with its share — the numbers a donut hides.
  colored.forEach((s, i) => {
    const y = 60 + i * 22;
    const label = s.name.length > 26 ? `${s.name.slice(0, 25)}…` : s.name;
    parts.push(`<rect x="380" y="${y - 9}" width="10" height="10" fill="${s.color}"/>`);
    parts.push(`<text x="398" y="${y}" fill="${COLORS.fg}" font-family="monospace" font-size="11">${esc(label)}</text>`);
    parts.push(`<text x="${WIDTH - M.right}" y="${y}" fill="${COLORS.dim}" font-family="monospace" font-size="11" text-anchor="end">${(Math.round((s.value / total) * 1000) / 10).toFixed(1)} %</text>`);
  });
  if (left > 0) parts.push(`<text x="380" y="${HEIGHT - 24}" fill="${COLORS.dim}" font-family="monospace" font-size="10">${left} value${left === 1 ? '' : 's'} of zero or less left out</text>`);
  parts.push('</svg>');
  return parts.join('');
}
