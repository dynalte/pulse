import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? 'dev'),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Le handler push (public/push-sw.js) est importé par le service worker
      // généré : notifications Web Push + clic pour ouvrir la conversation.
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        importScripts: ['push-sw.js'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'Pulse — Messagerie',
        short_name: 'Pulse',
        description: 'Messagerie privée sur invitation : discussions, groupes, photos et messages vocaux.',
        lang: 'fr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0a0f1c',
        theme_color: '#0a0f1c',
        categories: ['social', 'communication'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Nouvelle discussion', url: './#/contacts', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
        ],
      },
    }),
  ],
  base: './',
  server: {
    port: 8102,
    proxy: {
      // En dev : `npm run api` puis les appels /api-messagerie.php partent vers PHP.
      '/api-messagerie.php': 'http://127.0.0.1:8110',
      '/data/': 'http://127.0.0.1:8110',
    },
  },
  preview: { port: 8102 },
});
