import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // The atproto-repo factory uses jsr-style bare specifiers; map them to the
      // npm `hono` package and the sibling workspace libs for the browser build.
      '@hono/hono/cors': 'hono/cors',
      '@hono/hono': 'hono',
      '@publicdomainrelay/event-bus': fileURLToPath(
        new URL('../lib/event-bus/mod.ts', import.meta.url),
      ),
      '@publicdomainrelay/xrpc-relay': fileURLToPath(
        new URL('../lib/xrpc-relay/mod.ts', import.meta.url),
      ),
    },
  },
})
