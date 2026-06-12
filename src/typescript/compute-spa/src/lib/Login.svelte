<script lang="ts">
  import { auth } from './auth.svelte.ts';

  let handle = $state('');

  function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    auth.signIn(handle);
  }
</script>

<div class="login-wrap">
  <h1>Compute Contract Provider</h1>
  <p class="subtitle">Provision virtual machines via the AT Protocol</p>

  <form {onsubmit}>
    <label for="handle">AT Protocol Handle</label>
    <input
      id="handle"
      type="text"
      placeholder="alice.bsky.social"
      bind:value={handle}
      required
      disabled={auth.loginBusy}
    />
    <button type="submit" disabled={auth.loginBusy || !handle.trim()}>
      {auth.loginBusy ? 'Redirecting…' : 'Sign in with Bluesky'}
    </button>
  </form>

  {#if auth.loginError}
    <p class="error">{auth.loginError}</p>
  {/if}

  <p class="hint">Don't have an account? <a href="https://bsky.app" target="_blank" rel="noreferrer">Create one on Bluesky</a></p>
</div>

<style>
  .login-wrap {
    max-width: 400px;
    margin: 10vh auto;
    padding: 2rem;
    border: 1px solid #dde3ec;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.07);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  h1 { font-size: 1.4rem; margin: 0; color: #1c2333; }
  .subtitle { color: #64748b; margin: 0; font-size: 0.9rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-size: 0.85rem; color: #64748b; }
  input {
    padding: 0.6rem 0.8rem;
    border-radius: 6px;
    border: 1px solid #dde3ec;
    background: #f8fafc;
    color: #1c2333;
    font-size: 1rem;
  }
  input:focus { outline: none; border-color: #4a9eff; background: #fff; }
  button {
    padding: 0.7rem;
    border-radius: 6px;
    border: none;
    background: #4a9eff;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
  }
  button:hover:not(:disabled) { background: #3a8eef; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { color: #dc2626; font-size: 0.9rem; margin: 0; }
  .hint { color: #94a3b8; font-size: 0.8rem; margin: 0; }
  a { color: #4a9eff; }
</style>
