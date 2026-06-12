import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'

export default defineConfig({
  plugins: [svelte()],
  define: { 'process.env': {} },
  server: { hmr: { overlay: false } },
  resolve: {
    alias: {
      '@publicdomainrelay/lexicons': path.resolve(__dirname, '../lib/lexicons/mod.ts'),
      '@publicdomainrelay/market': path.resolve(__dirname, '../lib/market/mod.browser.ts'),
    },
  },
})
