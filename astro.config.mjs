import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel/serverless';

// To run locally with Node instead of Vercel:
//   import node from '@astrojs/node';
//   adapter: node({ mode: 'standalone' }),

export default defineConfig({
  output: 'hybrid',
  adapter: vercel(),
  integrations: [
    tailwind({ applyBaseStyles: false }),
  ],
});
