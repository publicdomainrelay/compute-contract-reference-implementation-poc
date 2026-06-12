<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from './auth.svelte.ts';
  import { CLOUD_INIT_PRESETS } from './cloud-init-presets.ts';
  import LiveGraph from './LiveGraph.svelte';
  import { relayClient } from './relay-client.svelte.ts';
  import { tabFromHash, navigateToHash, type TabName } from './navigation.ts';
  import { loadSavedVMs, persistVM, removeVM, type SavedVM } from './vm-storage.ts';
  import { requestVM } from './vm-market.ts';

  let activeTab = $state<TabName>(tabFromHash());

  function navigate(tab: TabName) {
    activeTab = tab;
    navigateToHash(tab);
    if (tab === 'live-graph') setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
  }

  onMount(() => {
    const onHashChange = () => {
      sessionStorage.setItem('activeHash', window.location.hash);
      activeTab = tabFromHash();
      if (activeTab === 'live-graph') setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });

  let showLoginModal = $state(false);
  let loginHandle = $state('');

  let vmName = $state('test-0001');
  let selectedPresetId = $state('minimal');
  let cloudInitScript = $state(CLOUD_INIT_PRESETS[0].script);
  let bidWindowSec = $state(5);
  let submitting = $state(false);
  let submitResult = $state<{ success: boolean; message: string } | null>(null);
  let logs = $state<string[]>([]);
  let savedVMs = $state<SavedVM[]>(loadSavedVMs());

  let selectedPreset = $derived(
    CLOUD_INIT_PRESETS.find((p) => p.id === selectedPresetId) ?? CLOUD_INIT_PRESETS[0]
  );

  function onPresetChange() {
    if (selectedPresetId !== 'custom') cloudInitScript = selectedPreset.script;
  }

  function addLog(msg: string) {
    logs = [...logs, `${new Date().toISOString().slice(11, 23)} ${msg}`];
  }

  async function deleteVM(vm: SavedVM) {
    if (vm.submitEventRef && vm.receiptUri && vm.receiptCid && auth.agent) {
      try {
        const { createRecord, createMarketClient } = await import('@publicdomainrelay/market') as {
          createRecord: (agent: unknown, col: string, rec: Record<string, unknown>) => Promise<{ uri: string; cid: string }>;
          createMarketClient: (session: unknown, opts: Record<string, unknown>) => {
            submitEvent: (target: string, event: Record<string, unknown>) => Promise<{ ok: boolean }>;
          };
        };
        const VM_DELETE_NSID = 'com.publicdomainrelay.temp.compute.events.vm.delete';
        const EVENT_NSID = 'com.publicdomainrelay.temp.market.event';
        const nowIso = new Date().toISOString();
        const deleteRef = await createRecord(auth.agent, VM_DELETE_NSID, {
          $type: VM_DELETE_NSID,
          reason: 'user_requested',
          createdAt: nowIso,
        });
        const keypair = relayClient.getAttestationKeypair();
        const proxyRef = relayClient.proxyRef;
        const mc = createMarketClient(auth.agent, keypair && proxyRef ? { agent: auth.agent, signer: { keypair, issuer: proxyRef } } : { agent: auth.agent });
        await mc.submitEvent(vm.submitEventRef, {
          $type: EVENT_NSID,
          receipt: { $type: 'com.atproto.repo.strongRef', uri: vm.receiptUri, cid: vm.receiptCid },
          payload: { $type: 'com.atproto.repo.strongRef', uri: deleteRef.uri, cid: deleteRef.cid },
          createdAt: nowIso,
        });
      } catch (err) {
        console.error('[deleteVM] submitEvent failed:', err);
      }
    }
    savedVMs = removeVM(savedVMs, vm.vmUri);
  }

  async function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!auth.agent) return;
    submitting = true;
    submitResult = null;
    logs = [];
    try {
      const proxyRef = relayClient.proxyRef;
      if (!proxyRef) throw new Error('relay not connected — connect to xrpc-relay first');
      const result = await requestVM({
        agent: auth.agent,
        proxyRef,
        keypair: relayClient.getAttestationKeypair(),
        vmName,
        cloudInitScript,
        bidWindowSec,
        onLog: addLog,
      });
      savedVMs = persistVM(savedVMs, {
        name: vmName,
        vmUri: result.vmUri,
        rfpUri: result.rfpUri,
        acceptUri: result.acceptUri,
        bidUri: result.bidUri,
        createdAt: new Date().toISOString(),
        receiptUri: result.receiptUri,
        receiptCid: result.receiptCid,
        submitEventRef: result.submitEventRef,
      });
      submitResult = { success: true, message: `VM "${vmName}" accepted (bid: ${result.bidUri})` };
    } catch (err) {
      addLog(`error: ${String(err)}`);
      submitResult = { success: false, message: String(err) };
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
      <button class="tab" class:active={activeTab === 'live-graph'} onclick={() => navigate('live-graph')}>
        Live Graph
      </button>
      <button class="tab" class:active={activeTab === 'dashboard'} onclick={() => navigate('dashboard')}>
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

  <div class="graph-wrapper" style:display={activeTab === 'live-graph' ? '' : 'none'}>
    <LiveGraph />
  </div>

  {#if activeTab === 'dashboard'}
    <main>
      <section class="card">
        <h2>Request Virtual Machine</h2>

        <div class="relay-status" class:relay-ok={relayClient.status === 'connected'}>
          relay: {relayClient.status}{relayClient.proxyRef ? ` — ${relayClient.proxyRef}` : ''}
        </div>

        <form {onsubmit}>
          <div class="field">
            <label for="vm-name">VM Name / Role</label>
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
            <label for="bid-window">Bid Window (seconds)</label>
            <input
              id="bid-window"
              type="number"
              min="5"
              max="300"
              bind:value={bidWindowSec}
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
            disabled={submitting || (!!auth.handle && (!vmName.trim() || relayClient.status !== 'connected'))}
            class:needs-login={!auth.handle}
            onclick={!auth.handle ? () => showLoginModal = true : undefined}
          >
            {#if !auth.handle}Request VM — Please Log In{:else if submitting}Running market RFP…{:else}Request VM via Market{/if}
          </button>
        </form>

        {#if logs.length > 0}
          <div class="log-box">
            {#each logs as line, i (i)}<div>{line}</div>{/each}
          </div>
        {/if}

        {#if submitResult}
          <p class="result" class:success={submitResult.success} class:error={!submitResult.success}>
            {submitResult.message}
          </p>
        {/if}
      </section>

      {#if savedVMs.length > 0}
        <section class="card vm-list">
          <h2>My VMs</h2>
          {#each savedVMs as vm (vm.vmUri)}
            <div class="vm-row">
              <div class="vm-info">
                <span class="vm-name">{vm.name}</span>
                <span class="vm-meta">{new Date(vm.createdAt).toLocaleString()}</span>
                <a class="vm-uri" href={vm.vmUri} target="_blank" rel="noopener">{vm.vmUri}</a>
              </div>
              <button class="vm-remove" onclick={() => deleteVM(vm)} title="Remove">✕</button>
            </div>
          {/each}
        </section>
      {/if}
    </main>
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
  .relay-status {
    font-size: 0.78rem;
    color: #94a3b8;
    margin-bottom: 1rem;
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .relay-status.relay-ok { color: #16a34a; background: #f0fdf4; border-color: #bbf7d0; }
  .log-box {
    margin-top: 1rem;
    text-align: left;
    padding: 0.6rem 0.8rem;
    border-radius: 6px;
    background: #0f172a;
    color: #94a3b8;
    font-family: monospace;
    font-size: 0.78rem;
    line-height: 1.6;
    max-height: 180px;
    overflow-y: auto;
  }
  .result { margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 6px; font-size: 0.88rem; }
  .result.success { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .result.error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }

  .vm-list { margin-top: 1.5rem; }
  .vm-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid #f1f5f9;
  }
  .vm-row:last-child { border-bottom: none; }
  .vm-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
  .vm-name { font-weight: 600; font-size: 0.9rem; color: #1c2333; }
  .vm-meta { font-size: 0.75rem; color: #94a3b8; }
  .vm-uri {
    font-size: 0.75rem;
    font-family: monospace;
    color: #4a9eff;
    word-break: break-all;
    text-decoration: none;
  }
  .vm-uri:hover { text-decoration: underline; }
  .vm-remove {
    flex-shrink: 0;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #e2e8f0;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    font-size: 0.75rem;
    line-height: 1;
    transition: all 0.15s;
  }
  .vm-remove:hover { border-color: #f87171; color: #f87171; }

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
