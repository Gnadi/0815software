import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

// Tailwind v3 is handled via PostCSS (postcss.config.mjs) — no Astro integration needed.
// To run locally: npx @astrojs/node or just use `astro dev` (server rendering works in dev).

export default defineConfig({
  site: 'https://0815software.vercel.app',
  output: 'static',
  adapter: vercel(),
  integrations: [sitemap()],
  redirects: {
    // MOD-15 was called Dashboard before it was renamed Workspace, and the old
    // detail page was linked from the landing page and indexed under that slug.
    '/modules/dashboard': '/modules/workspace',
  },
});
