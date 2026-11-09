/**
 * Build of the extension's pages (side panel, focus page). The service worker and the
 * scripts injected into web pages are built by scripts/build.mjs with their own configs:
 * the worker as one ES module, each injected script as one self-contained IIFE (what
 * chrome.scripting.executeScript needs).
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

export const alias = {
  '@': resolve(here, 'src'),
  '@anemo/schema': resolve(here, '../frontend/src/api/schema.d.ts'),
  // The focus timer's rules (pure functions), the same as in Anemo.
  '@anemo/timer': resolve(here, '../frontend/src/features/focus/timer.ts'),
}

export default defineConfig(({ mode }) => ({
  root: resolve(here, 'src'),
  base: '/',
  publicDir: resolve(here, 'public'),
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  define: { __DEV__: JSON.stringify(mode !== 'production'), __E2E__: 'false', __BROWSER_CONTROL__: 'false' },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: mode !== 'production',
    // Extension pages load from disk: one chunk per page is fine, no size warnings.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        panel: resolve(here, 'src/panel/index.html'),
        blocked: resolve(here, 'src/pages/blocked.html'),
      },
    },
  },
}))
