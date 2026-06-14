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
      '@publicdomainrelay/hono-factory-atproto-repo': path.resolve(__dirname, '../lib/hono-factory-atproto-repo/mod.ts'),
      '@publicdomainrelay/did-plc': path.resolve(__dirname, '../lib/did-plc/mod.ts'),
      '@publicdomainrelay/event-bus': path.resolve(__dirname, '../lib/event-bus/mod.ts'),
      '@publicdomainrelay/xrpc-relay': path.resolve(__dirname, '../lib/xrpc-relay/mod.ts'),
      '@hono/hono': 'hono',
      '@hono/hono/cors': 'hono/cors',
    },
  },
})
