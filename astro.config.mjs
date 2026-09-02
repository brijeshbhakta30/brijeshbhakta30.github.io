import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://brijeshbhakta.com',
  output: 'static',
  publicDir: './static',
  integrations: [
    sitemap({
      filter: (page) =>
        page !== 'https://brijeshbhakta.com/getting-started-with-es6/',
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    host: true,
    allowedHosts: true,
  },
});
