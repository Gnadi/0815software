import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

// Swap adapter for your deployment target:
//   Netlify:    @astrojs/netlify
//   Vercel:     @astrojs/vercel/serverless
//   Cloudflare: @astrojs/cloudflare
//   Self-host:  @astrojs/node (current)

export default defineConfig({
  output: 'hybrid',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    tailwind({ applyBaseStyles: false }),
  ],
});
