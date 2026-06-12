<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from './lib/auth.svelte.ts';
  import { relayClient } from './lib/relay-client.svelte.ts';
  import Dashboard from './lib/Dashboard.svelte';

  onMount(() => {
    auth.init();
    relayClient.start();
  });
</script>

{#if auth.loading}
  <div class="splash">
    <p>Loading session…</p>
  </div>
{:else if auth.error}
  <div class="splash error">
    <p>Error: {auth.error}</p>
  </div>
{:else}
  <Dashboard />
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f4f6fb;
    color: #1c2333;
  }
  .splash {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    color: #64748b;
  }
  .splash.error { color: #dc2626; }
</style>
