<script lang="ts">
  import { auth } from './auth.svelte.ts';
  import { CLOUD_INIT_PRESETS, type CloudInitPreset } from './cloud-init-presets.ts';
  import LiveGraph from './LiveGraph.svelte';
  let activeTab = $state<'dashboard' | 'live-graph'>('live-graph');
  let showLoginModal = $state(false);
  let loginHandle = $state('');

  let vmName = $state('');
  let selectedPresetId = $state('minimal');
  let cloudInitScript = $state(CLOUD_INIT_PRESETS[0].script);
  let submitting = $state(false);
  let submitResult = $state<{ success: boolean; message: string } | null>(null);

  let selectedPreset = $derived(
    CLOUD_INIT_PRESETS.find((p) => p.id === selectedPresetId) ?? CLOUD_INIT_PRESETS[0]
  );

  function onPresetChange() {
    if (selectedPresetId !== 'custom') {
      cloudInitScript = selectedPreset.script;
    }
  }

  async function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    submitting = true;
    submitResult = null;
    try {
      const res = await fetch('/api/vm/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: vmName,
          did: auth.did,
          handle: auth.handle,
          cloudInit: cloudInitScript,
        }),
      });
      if (res.ok) {
        submitResult = { success: true, message: `VM "${vmName}" queued successfully.` };
        vmName = '';
      } else {
        const text = await res.text();
        submitResult = { success: false, message: `Error ${res.status}: ${text}` };
      }
    } catch (e) {
      submitResult = { success: false, message: String(e) };
    } finally {
      submitting = false;
    }
  }
</script>

<div class="dashboard">
  <header>
    <div class="brand">
      <h1>Compute Contract Provider</h1>
    </div>
    <nav class="tabs">
      <button class="tab" class:active={activeTab === 'live-graph'} onclick={() => activeTab = 'live-graph'}>
        Live Graph
      </button>
      <button class="tab" class:active={activeTab === 'dashboard'} onclick={() => activeTab = 'dashboard'}>
        Request VM
      </button>
    </nav>
    {#if auth.handle}
      <span class="handle">@{auth.handle}</span>
      <button class="logout" onclick={() => auth.signOut()}>Sign out</button>
    {:else}
      <button class="login-btn" onclick={() => showLoginModal = true}>Log In</button>
    {/if}
  </header>

  {#if activeTab === 'dashboard'}
    <main>
      <section class="card">
        <h2>Request Virtual Machine</h2>

        <form {onsubmit}>
          <div class="field">
            <label for="vm-name">VM Name</label>
            <input
              id="vm-name"
              type="text"
              placeholder="my-vm-01"
              bind:value={vmName}
              required
              disabled={submitting}
            />
          </div>

          <div class="field">
            <label for="preset">Cloud-Init Preset</label>
            <select id="preset" bind:value={selectedPresetId} onchange={onPresetChange} disabled={submitting}>
              {#each CLOUD_INIT_PRESETS as preset (preset.id)}
                <option value={preset.id}>{preset.label} — {preset.description}</option>
              {/each}
            </select>
          </div>

          <div class="field">
            <label for="cloud-init">Cloud-Init Script</label>
            <textarea
              id="cloud-init"
              rows="14"
              bind:value={cloudInitScript}
              disabled={submitting}
              spellcheck="false"
            ></textarea>
          </div>

          <button
            type={auth.handle ? 'submit' : 'button'}
            disabled={submitting || (!!auth.handle && !vmName.trim())}
            class:needs-login={!auth.handle}
            onclick={!auth.handle ? () => showLoginModal = true : undefined}
          >
            {#if !auth.handle}Create VM — Please Log In{:else if submitting}Creating…{:else}Create VM{/if}
          </button>
        </form>

        {#if submitResult}
          <p class="result" class:success={submitResult.success} class:error={!submitResult.success}>
            {submitResult.message}
          </p>
        {/if}
      </section>
    </main>
  {:else}
    <div class="graph-wrapper">
      <LiveGraph />
    </div>
  {/if}
</div>

{#if showLoginModal}
  <div class="modal-backdrop" onclick={() => showLoginModal = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h2>Sign in with Bluesky</h2>
      <form onsubmit={(e) => { e.preventDefault(); auth.signIn(loginHandle); }}>
        <label for="modal-handle">AT Protocol Handle</label>
        <input
          id="modal-handle"
          type="text"
          placeholder="alice.bsky.social"
          bind:value={loginHandle}
          required
          disabled={auth.loginBusy}
          autofocus
        />
        <button type="submit" disabled={auth.loginBusy || !loginHandle.trim()}>
          {auth.loginBusy ? 'Redirecting…' : 'Sign in'}
        </button>
      </form>
      {#if auth.loginError}
        <p class="login-error">{auth.loginError}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dashboard {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: #f4f6fb;
    color: #1c2333;
  }
  header {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.75rem 2rem;
    border-bottom: 1px solid #dde3ec;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .brand { display: flex; align-items: baseline; gap: 0.75rem; }
  .brand h1 { margin: 0; font-size: 1.15rem; color: #1c2333; }
  .handle { color: #4a9eff; font-size: 0.85rem; }

  .tabs { display: flex; gap: 0.25rem; margin-left: auto; }
  .tab {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.15s;
  }
  .tab:hover { background: #f0f4ff; color: #1c2333; }
  .tab.active {
    background: #4a9eff;
    color: #fff;
    border-color: #4a9eff;
  }

  .logout {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    border: 1px solid #dde3ec;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.15s;
  }
  .logout:hover { border-color: #f87171; color: #f87171; }

  main { padding: 2rem; max-width: 700px; width: 100%; margin: 0 auto; }

  .card {
    background: #ffffff;
    border: 1px solid #dde3ec;
    border-radius: 10px;
    padding: 1.5rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  }
  h2 { margin: 0 0 1.5rem; font-size: 1.05rem; color: #1c2333; }
  form { display: flex; flex-direction: column; gap: 1.25rem; }
  .field { display: flex; flex-direction: column; gap: 0.4rem; }
  label { font-size: 0.82rem; color: #64748b; font-weight: 500; }
  input, select, textarea {
    padding: 0.55rem 0.8rem;
    border-radius: 6px;
    border: 1px solid #dde3ec;
    background: #f8fafc;
    color: #1c2333;
    font-size: 0.9rem;
    font-family: inherit;
    transition: border-color 0.15s;
  }
  textarea { resize: vertical; font-family: 'Courier New', monospace; font-size: 0.83rem; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #4a9eff; background: #fff; }
  button[type="submit"] {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    border: 1px solid #4a9eff;
    background: #4a9eff;
    color: #fff;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background 0.15s;
  }
  button[type="submit"]:hover:not(:disabled) { background: #3a8eef; border-color: #3a8eef; }
  button[type="submit"]:disabled { opacity: 0.5; cursor: not-allowed; }
  button[type="submit"].needs-login { background: #94a3b8; border-color: #94a3b8; }
  button[type="submit"].needs-login:hover:not(:disabled) { background: #7f8ea8; border-color: #7f8ea8; }
  .result { margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 6px; font-size: 0.88rem; }
  .result.success { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .result.error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }

  .graph-wrapper { flex: 1; padding: 1rem 1.5rem; }

  .handle { color: #4a9eff; font-size: 0.85rem; }
  .login-btn {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    border: 1px solid #4a9eff;
    background: #4a9eff;
    color: #fff;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background 0.15s;
  }
  .login-btn:hover { background: #3a8eef; }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: #fff;
    border-radius: 10px;
    padding: 2rem;
    width: min(400px, 90vw);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  }
  .modal h2 { margin: 0; font-size: 1.1rem; color: #1c2333; }
  .modal form { display: flex; flex-direction: column; gap: 0.75rem; }
  .modal label { font-size: 0.85rem; color: #64748b; }
  .login-error { color: #dc2626; font-size: 0.88rem; margin: 0; }

</style>
