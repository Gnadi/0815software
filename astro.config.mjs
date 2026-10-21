import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Tailwind runs as a Vite plugin: since Astro 7 (Vite 8) the PostCSS plugin
// no longer gets to resolve `@import "tailwindcss"` before Vite does.
// To run locally: npx @astrojs/node or just use `astro dev` (server rendering works in dev).

export default defineConfig({
  site: 'https://0815software.vercel.app',
  output: 'static',
  adapter: vercel(),
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  redirects: {
    // MOD-15 was called Dashboard before it was renamed Workspace, and the old
    // detail page was linked from the landing page and indexed under that slug.
    '/modules/dashboard': '/modules/workspace',
    // The case studies were replaced by the use cases, and the page that listed
    // all use cases at length by the list on the landing page plus one page per
    // use case (/use-cases/<id>); keep old links working.
    '/case-studies': '/#use-cases',
    '/use-cases': '/#use-cases',
  },
});
