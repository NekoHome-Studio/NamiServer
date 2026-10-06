import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

/**
 * Builds the WebUI straight into `src/web/app`, which the Nami server serves at
 * `/admin`. `base` must match that mount point so asset URLs resolve.
 */
export default defineConfig({
  base: '/admin/',
  plugins: [
    vue(),
    // Auto-imports the Vuetify components actually used, so the bundle only
    // carries what the app references. Theme colours live in JS
    // (src/plugins/vuetify.ts) to avoid pulling in a Sass toolchain.
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../src/web/app',
    emptyOutDir: true,
    // The bundle is a build artifact committed to the repo, so keep it honest:
    // sourcemaps off, and a warning threshold that would flag real bloat.
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router'],
          vuetify: ['vuetify'],
        },
      },
    },
  },
  server: {
    port: 5199,
    // `npm run dev` proxies to a locally running Nami so the SPA talks to real data.
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/readyz': 'http://127.0.0.1:8787',
      '/openapi.json': 'http://127.0.0.1:8787',
    },
  },
});
