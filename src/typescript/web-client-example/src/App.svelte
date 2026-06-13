<script lang="ts">
  import { onMount } from 'svelte';
  import { RelaySubscriber, DISPATCHER_HOST, type Status, type LogEvent, type SubscriptionInfo } from './lib/relay-subscriber.ts';
  import { startLocalPds, type LocalPds } from './lib/local-pds.ts';

  let status = $state<Status>('disconnected');
  let logs = $state<LogEvent[]>([]);
  let subscriptions = $state<SubscriptionInfo[]>([]);
  let subscriber: RelaySubscriber | null = $state(null);
  let logContainer = $state<HTMLDivElement | null>(null);
  let autoScroll = $state(true);
  let pds: LocalPds | null = $state(null);
  let bootError = $state('');

  const MAX_LOGS = 200;

  function addLog(ev: LogEvent) {
    logs = [...logs.slice(-(MAX_LOGS - 1)), ev];
    if (autoScroll && logContainer) {
      requestAnimationFrame(() => { logContainer!.scrollTop = logContainer!.scrollHeight; });
    }
  }

  async function connect() {
    if (subscriber) return;
    bootError = '';
    status = 'connecting';

    try {
      // Boot the in-browser PDS with did:plc, then wire its service-auth token
      // provider into the relay subscriber.
      if (!pds) {
        pds = await startLocalPds();
      }
    } catch (err) {
      bootError = `PDS boot failed: ${err}`;
      status = 'error';
      return;
    }

    subscriber = new RelaySubscriber({
      onStatus(s) { status = s; },
      onLog(e) { addLog(e); },
      onSubscription(sub) {
        subscriptions = [...subscriptions, sub];
      },
      onSubscriptionEvent(subId, _message) {
        subscriptions = subscriptions.map((s) =>
          s.subscriptionId === subId ? { ...s, eventCount: s.eventCount + 1 } : s
        );
      },
    });

    await subscriber.connect((lxm) => pds!.getServiceAuth(`did:web:${DISPATCHER_HOST}`, lxm));
  }

  function disconnect() {
    subscriber?.stop();
    subscriber = null;
    status = 'disconnected';
    subscriptions = [];
  }

  onMount(() => {
    connect();
    return () => disconnect();
  });

  function statusLabel(s: Status): string {
    switch (s) {
      case 'disconnected': return '● disconnected';
      case 'connecting': return '◌ connecting…';
      case 'connected': return '● connected';
      case 'error': return '✕ error';
    }
  }

  function statusClass(s: Status): string {
    switch (s) {
      case 'connected': return 'status-ok';
      case 'connecting': return 'status-pending';
      case 'error': return 'status-err';
      default: return 'status-off';
    }
  }

  function severityClass(sev: string): string {
    switch (sev) {
      case 'error': return 'sev-error';
      case 'warn': return 'sev-warn';
      case 'event': return 'sev-event';
      default: return 'sev-info';
    }
  }

  function fmtTime(ts: string): string {
    return new Date(ts).toLocaleTimeString();
  }
</script>

<div class="app">
  <header>
    <h1>relay subscriber</h1>
    <p class="subhead">demo — in-browser PDS + WebSocket relay subscription</p>
  </header>

  <section class="connect-panel">
    <div class="status-bar">
      <span class={`status-dot ${statusClass(status)}`}></span>
      <span>{statusLabel(status)}</span>
      {#if pds}
        <code class="did-badge">{pds.did}</code>
      {/if}
      {#if subscriber?.subdomain}
        <code class="subdomain-badge">{subscriber.subdomain}</code>
      {/if}
    </div>
    {#if bootError}
      <div class="boot-error">{bootError}</div>
    {/if}
  </section>

  <section class="body-panels">
    <div class="panel subscriptions-panel">
      <h2>subscriptions ({subscriptions.length})</h2>
      {#if subscriptions.length === 0}
        <p class="empty">no active subscriptions — open a WebSocket to<br /> <code>{"wss://<subdomain>.xrpc.fedproxy.com/xrpc/<nsid>"}</code></p>
      {:else}
        <div class="sub-list">
          {#each subscriptions as sub}
            <div class="sub-card">
              <div class="sub-header">
                <code class="sub-id">{sub.subscriptionId.slice(0, 8)}</code>
                <code class="sub-nsid">{sub.nsid}</code>
                <span class="sub-count">{sub.eventCount} events</span>
              </div>
              {#if Object.keys(sub.params).length > 0}
                <div class="sub-params">
                  {#each Object.entries(sub.params) as [k, v]}
                    <span class="param-tag"><em>{k}</em>=<code>{v}</code></span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="panel log-panel">
      <h2>event log</h2>
      <div class="log-container" bind:this={logContainer}>
        <label class="auto-scroll">
          <input type="checkbox" bind:checked={autoScroll} /> auto-scroll
        </label>
        {#each logs as ev}
          <div class="log-line {severityClass(ev.severity)}">
            <span class="log-ts">{fmtTime(ev.ts)}</span>
            <span class="log-sev">[{ev.severity}]</span>
            <span class="log-msg">{ev.message}</span>
          </div>
        {/each}
        {#if logs.length === 0}
          <p class="empty">booting in-browser PDS on page load…</p>
        {/if}
      </div>
    </div>
  </section>
</div>

<style>
  .app {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px 16px;
    font-family: system-ui, -apple-system, sans-serif;
    color: var(--text, #222);
    height: 100vh;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  header h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
  }
  .subhead {
    margin: 4px 0 0;
    font-size: 14px;
    opacity: 0.6;
  }

  .connect-panel {
    margin: 16px 0;
    padding: 16px;
    background: var(--code-bg, #f4f3ec);
    border-radius: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .row button {
    padding: 8px 20px;
    background: var(--accent, #6366f1);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  .row button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .status-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 13px;
  }
  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }
  .status-ok { background: #22c55e; }
  .status-pending { background: #f59e0b; animation: pulse 1s infinite; }
  .status-err { background: #ef4444; }
  .status-off { background: #9ca3af; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .did-badge {
    font-size: 11px;
    padding: 2px 6px;
    background: var(--accent-bg, rgba(99, 102, 241, 0.1));
    border-radius: 3px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subdomain-badge {
    font-size: 11px;
    padding: 2px 6px;
    background: var(--accent-bg, rgba(99, 102, 241, 0.1));
    border-radius: 3px;
  }
  .boot-error {
    margin-top: 8px;
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    border-radius: 4px;
    font-size: 13px;
    font-family: ui-monospace, monospace;
  }

  .body-panels {
    display: flex;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }
  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .panel h2 {
    margin: 0 0 8px;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.5;
  }

  .subscriptions-panel { flex: 0 0 320px; }
  .sub-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sub-card {
    padding: 8px 10px;
    background: var(--code-bg, #f4f3ec);
    border-radius: 6px;
    font-size: 13px;
  }
  .sub-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .sub-id { font-size: 11px; opacity: 0.6; }
  .sub-nsid { font-size: 12px; font-weight: 600; }
  .sub-count { margin-left: auto; font-size: 11px; opacity: 0.6; }
  .sub-params { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
  .param-tag { font-size: 11px; background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; }

  .log-container {
    flex: 1;
    overflow-y: auto;
    background: var(--code-bg, #f4f3ec);
    border-radius: 6px;
    padding: 8px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.6;
    position: relative;
  }
  .auto-scroll {
    position: sticky;
    top: 0;
    float: right;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    background: var(--bg, #fff);
    border-radius: 3px;
    z-index: 1;
    cursor: pointer;
    user-select: none;
    opacity: 0.7;
  }
  .log-line { display: flex; gap: 6px; }
  .log-ts { opacity: 0.5; white-space: nowrap; }
  .log-sev { width: 50px; flex-shrink: 0; font-weight: 600; }
  .log-msg { white-space: pre-wrap; word-break: break-all; }
  .sev-error { color: #ef4444; }
  .sev-warn { color: #f59e0b; }
  .sev-event { color: #6366f1; }
  .sev-info { color: inherit; }

  .empty {
    font-size: 13px;
    opacity: 0.5;
    padding: 16px;
    text-align: center;
  }
  .empty code {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: rgba(0,0,0,0.06);
    padding: 1px 4px;
    border-radius: 3px;
  }

  @media (max-width: 640px) {
    .body-panels { flex-direction: column; }
    .subscriptions-panel { flex: 0 0 auto; }
  }
</style>
