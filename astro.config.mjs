import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Tailwind v3 is handled via PostCSS (postcss.config.mjs) — no Astro integration needed.
// To run locally: npx @astrojs/node or just use `astro dev` (server rendering works in dev).

export default defineConfig({
  output: 'static',
  adapter: vercel(),
});
