import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { renderChartSvg } from '../server/charts.js';
import type { ChartConfig, QueryResult } from '../shared/types.js';

/**
 * The chart kinds beyond one bar or line series: a pie (drawn as a donut),
 * an area, and several series — grouped or stacked bars, several lines — from
 * a series column. What is pinned is what a reader takes from the picture:
 * which values are drawn, where they sum, what the legend says, and that a
 * gap in the data is a gap in the line rather than a drop to zero.
 */

const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const result = (columns: string[], rows: unknown[][]): QueryResult => ({
  columns,
  rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
  truncated: false,
  elapsed_ms: 0,
});

const long = result(
  ['month', 'category', 'revenue'],
  [
    ['2025-01', 'Hardware', 100],
    ['2025-01', 'Software', 50],
    ['2025-02', 'Hardware', 120],
    ['2025-02', 'Software', 30],
    ['2025-02', 'Software', 10], // two rows for one cell: summed
    ['2025-03', 'Hardware', 80],
    // no Software in March
  ],
);

const titles = (svg: string): string[] => [...svg.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]!);
const rects = (svg: string): { y: number; h: number; fill: string }[] =>
  [...svg.matchAll(/<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)" fill="([^"]+)"><title>/g)].map((m) => ({ y: Number(m[1]), h: Number(m[2]), fill: m[3]! }));

describe('several series from a series column', () => {
  const grouped: ChartConfig = { kind: 'bar', x: 'month', y: 'revenue', series: 'category' };

  it('grouped bars: one bar per series and month, cells summed, a missing cell drawn as nothing', () => {
    const svg = renderChartSvg(long, grouped);
    expect(titles(svg)).toEqual(['Hardware · 2025-01: 100', 'Hardware · 2025-02: 120', 'Hardware · 2025-03: 80', 'Software · 2025-01: 50', 'Software · 2025-02: 40']);
    // The legend names both series in their colours.
    expect(svg).toContain('<rect x="64.00" y="10.00" width="9" height="9" fill="#e8e4dc"/><text x="77.00" y="18.00"');
    expect(svg).toMatch(/fill="#c08b8b"\/><text [^>]+>Software<\/text>/);
  });

  it('stacked bars: each month is one column as tall as its total', () => {
    const svg = renderChartSvg(long, { ...grouped, stacked: true });
    const bars = rects(svg);
    expect(bars).toHaveLength(5);
    // Drawn month by month. February: 120 + 40 — the two segments meet, and
    // together reach 160.
    const [hw, sw] = [bars[2]!, bars[3]!].sort((a, b) => b.y - a.y);
    expect(hw.y).toBeCloseTo(sw!.y + sw!.h, 1);
    const unit = bars[0]!.h / 100;
    expect(hw.h + sw!.h).toBeCloseTo(160 * unit, 1);
  });

  it('several lines: a series with no value for a month breaks there instead of dropping to zero', () => {
    const svg = renderChartSvg(long, { kind: 'line', x: 'month', y: 'revenue', series: 'category' });
    const lines = [...svg.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]!.split(' ').length);
    expect(lines).toEqual([3, 2]);
    // "Stacked" is meaningless for lines and is ignored, not misdrawn.
    expect(renderChartSvg(long, { kind: 'line', x: 'month', y: 'revenue', series: 'category', stacked: true })).toBe(svg);
  });

  it('a stacked area runs on the running total', () => {
    const svg = renderChartSvg(long, { kind: 'area', x: 'month', y: 'revenue', series: 'category', stacked: true });
    expect((svg.match(/<polygon /g) ?? []).length).toBe(2);
    expect(titles(svg)).toContain('Software · 2025-02: 40');
  });

  it('past eight series the lightest are summed into a grey "Other"', () => {
    const many = result(
      ['x', 's', 'v'],
      Array.from({ length: 10 }, (_, i) => ['a', `s${i}`, 100 - i]),
    );
    const svg = renderChartSvg(many, { kind: 'bar', x: 'x', y: 'v', series: 's' });
    expect(titles(svg)).toHaveLength(8);
    // Seven kept (100 … 94); s7 + s8 + s9 = 93 + 92 + 91.
    expect(titles(svg).at(-1)).toBe('Other (3) · a: 276');
    expect(svg).toContain('fill="#6b675f"><title>Other (3)');
  });
});

describe('area', () => {
  it('one series fills down to zero under its line', () => {
    const svg = renderChartSvg(result(['d', 'n'], [['a', 3], ['b', 5], ['c', 4]]), { kind: 'area', x: 'd', y: 'n' });
    expect((svg.match(/<polygon /g) ?? []).length).toBe(1);
    expect((svg.match(/<polyline /g) ?? []).length).toBe(1);
    expect(svg).not.toContain('font-size="10">n</text>'); // no legend for a single series
  });
});

describe('pie (donut)', () => {
  const regions = result(
    ['region', 'revenue'],
    [
      ['North', 300],
      ['South', 100],
      ['North', 100], // same label: one slice
      ['East', 0],
      ['West', -50],
    ],
  );

  it('one slice per label, the total in the middle, each share in the legend', () => {
    const svg = renderChartSvg(regions, { kind: 'pie', x: 'region', y: 'revenue' });
    expect(titles(svg)).toEqual(['North: 400 (80.0 %)', 'South: 100 (20.0 %)']);
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect(svg).toContain('text-anchor="middle">500</text>');
    expect(svg).toContain('>80.0 %</text>');
    // A share of a whole has no negative part — and the chart says what it left out.
    expect(svg).toContain('2 values of zero or less left out');
  });

  it('a single slice is the whole ring', () => {
    const svg = renderChartSvg(result(['k', 'v'], [['all', 7]]), { kind: 'pie', x: 'k', y: 'v' });
    expect(svg).toContain('<circle cx="200" cy="180" r="101" fill="none" stroke="#e8e4dc" stroke-width="58"><title>all: 7 (100.0 %)</title></circle>');
  });

  it('nothing positive is said in words, not drawn as an empty ring', () => {
    expect(renderChartSvg(result(['k', 'v'], [['a', 0]]), { kind: 'pie', x: 'k', y: 'v' })).toContain('no positive values to show');
  });

  it('has no series', () => {
    expect(() => renderChartSvg(long, { kind: 'pie', x: 'month', y: 'revenue', series: 'category' })).toThrow('a pie chart has no series');
  });
});

describe('every kind is well-formed SVG', () => {
  it('refuses a series column the result does not have', () => {
    expect(() => renderChartSvg(long, { kind: 'bar', x: 'month', y: 'revenue', series: 'region' })).toThrow('series column "region" is not in the report result');
  });

  it.skipIf(!HAVE_XMLLINT).each([
    ['bar', { kind: 'bar', x: 'month', y: 'revenue', series: 'category', stacked: true }],
    ['line', { kind: 'line', x: 'month', y: 'revenue', series: 'category' }],
    ['area', { kind: 'area', x: 'month', y: 'revenue', series: 'category', stacked: true }],
    ['pie', { kind: 'pie', x: 'category', y: 'revenue' }],
  ] as [string, ChartConfig][])('%s', (_kind, config) => {
    const named = result(['month', 'category', 'revenue'], [['<2025>', 'R&D "x"', 5], ['2026', "O'Brien", 3]]);
    execFileSync('xmllint', ['--noout', '-'], { input: renderChartSvg(named, config) });
  });
});
