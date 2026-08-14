/**
 * Regenerates public/og-image.png — the social preview card referenced by
 * og:image / twitter:image in src/layouts/Base.astro.
 *
 * Run from the repo root:  node scripts/generate-og-image.mjs
 *
 * Two prerequisites, because the card is drawn as SVG and rasterised:
 *
 *  1. `sharp` must resolve. It ships as an Astro dependency, so `npm ci` is
 *     enough — there is no separate entry in package.json.
 *  2. The three brand families (Inter Tight, JetBrains Mono, Instrument Serif)
 *     must be installed *system-wide*, not just as @fontsource packages. The
 *     rasteriser resolves font-family through fontconfig and silently falls
 *     back to a default face otherwise, which is easy to miss. The @fontsource
 *     files are woff2, which fontconfig does not read, so convert them first:
 *
 *       pip install fonttools brotli
 *       python3 -c "
 *       from fontTools.ttLib import TTFont
 *       for src, dst in [
 *         ('node_modules/@fontsource/inter-tight/files/inter-tight-latin-500-normal.woff2', 'InterTight-Medium.ttf'),
 *         ('node_modules/@fontsource/inter-tight/files/inter-tight-latin-400-normal.woff2', 'InterTight-Regular.ttf'),
 *         ('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', 'JetBrainsMono-Medium.ttf'),
 *         ('node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2', 'InstrumentSerif-Italic.ttf'),
 *       ]:
 *           f = TTFont(src); f.flavor = None; f.save('$HOME/.fonts/' + dst)
 *       "
 *       fc-cache -f
 *
 * Check the result before committing: the headline is hand-broken across three
 * lines so it clears the spec card, so any copy change needs the breaks redone.
 */
import sharp from 'sharp';

const OUT = 'public/og-image.png';

// Mirrors the @theme tokens in src/styles/global.css.
const BG = '#0A0A0A';
const FG = '#E8E4DC';
const DIM = '#A8A39A';
const MUTE = '#6B675F';
const LINE = 'rgba(232,228,220,0.12)';
const LINE_STRONG = 'rgba(232,228,220,0.22)';

const specs = [
  ['LICENSE', 'MIT'],
  ['LICENSE FEE', '€0.00'],
  ['SOURCE', 'GitHub / public'],
  ['LOCK-IN', 'None'],
  ['HAND-OFF', 'Full code + docs'],
];

const rows = specs
  .map(([k, v], i) => {
    const y = 254 + i * 46;
    const accent = k === 'LICENSE FEE';
    return `
    <text x="742" y="${y}" font-family="JetBrains Mono" font-size="16" fill="${MUTE}">${k}</text>
    <text x="1128" y="${y}" font-family="JetBrains Mono" font-size="16" fill="${accent ? FG : DIM}" text-anchor="end">${v}</text>
    <line x1="742" y1="${y + 16}" x2="1128" y2="${y + 16}" stroke="${LINE}" stroke-width="1"/>`;
  })
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>

  <!-- hairline margin rules, echoing the site's DIN-spec grid -->
  <line x1="72" y1="0" x2="72" y2="630" stroke="${LINE}" stroke-width="1"/>
  <line x1="0" y1="96" x2="1200" y2="96" stroke="${LINE}" stroke-width="1"/>
  <line x1="0" y1="534" x2="1200" y2="534" stroke="${LINE}" stroke-width="1"/>

  <!-- masthead -->
  <text x="112" y="60" font-family="JetBrains Mono" font-size="18" font-weight="500" fill="${FG}" letter-spacing="-0.2">0815software</text>
  <text x="1128" y="60" font-family="JetBrains Mono" font-size="14" fill="${MUTE}" text-anchor="end" letter-spacing="1">§ 01 · MANIFEST</text>

  <!-- eyebrow -->
  <text x="112" y="160" font-family="JetBrains Mono" font-size="15" fill="${DIM}" letter-spacing="0.6">
    <tspan fill="${FG}">●</tspan><tspan dx="10">INDEX 0815 — THE STANDARD SPEC</tspan>
  </text>

  <!-- headline — three lines, so it clears the spec card on the right -->
  <text x="112" y="248" font-family="Inter Tight Medium" font-size="72" fill="${FG}" letter-spacing="-2.4">Standard software,</text>
  <text x="112" y="320" font-family="Inter Tight Medium" font-size="72" fill="${FG}" letter-spacing="-2.4">built to a <tspan font-family="Instrument Serif" font-style="italic" font-size="76">higher</tspan></text>
  <text x="112" y="392" font-family="Inter Tight Medium" font-size="72" fill="${FG}" letter-spacing="-2.4">standard.</text>

  <!-- subhead -->
  <text x="112" y="452" font-family="Inter Tight" font-size="20" fill="${DIM}">CRUD apps, dashboards, storefronts and internal tools —</text>
  <text x="112" y="484" font-family="Inter Tight" font-size="20" fill="${DIM}">shipped in weeks, MIT-licensed, source in your hands day one.</text>

  <!-- spec card -->
  <rect x="710" y="150" width="450" height="345" fill="none" stroke="${LINE_STRONG}" stroke-width="1"/>
  <text x="742" y="190" font-family="JetBrains Mono" font-size="13" fill="${MUTE}" letter-spacing="1.4">SPECIFICATION</text>
  <text x="1128" y="190" font-family="JetBrains Mono" font-size="13" fill="${MUTE}" text-anchor="end" letter-spacing="1.4">0815/A</text>
  <line x1="742" y1="208" x2="1128" y2="208" stroke="${LINE}" stroke-width="1"/>
  ${rows}

  <!-- footer rule -->
  <text x="112" y="580" font-family="JetBrains Mono" font-size="15" fill="${MUTE}" letter-spacing="0.6">MIT-LICENSED · NO LOCK-IN · LINZ, AT</text>
  <text x="1128" y="580" font-family="JetBrains Mono" font-size="15" fill="${DIM}" text-anchor="end" letter-spacing="0.6">0815software.com</text>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(OUT);
console.log(`wrote ${OUT}`);
