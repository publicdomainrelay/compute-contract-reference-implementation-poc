import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';
import { startLocalPds, type LocalPds } from './local-pds.ts';

async function buildClientId(): Promise<string> {
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (isLocal) {
    const meta = await fetch('/oauth-client-metadata.json').then((r) => r.json()) as { scope?: string };
    return `http://localhost?${new URLSearchParams({
      scope: meta.scope ?? 'atproto',
      redirect_uri: Object.assign(new URL(window.location.origin), { hostname: '127.0.0.1' }).href,
    })}`;
  }
  return `https://${window.location.host}/oauth-client-metadata.json`;
}

class AuthState {
  loading = $state(true);
  error = $state<string | null>(null);
  handle = $state<string | null>(null);
  did = $state<string | null>(null);
  loginError = $state<string | null>(null);
  loginBusy = $state(false);

  #oac: BrowserOAuthClient | null = null;
  #agent: Agent | null = null;
  #localPds: LocalPds | null = null;

  get agent(): Agent | LocalPds['agent'] | null {
    // Return the local PDS agent by default; fall back to OAuth Agent if present.
    if (this.#localPds) return this.#localPds.agent;
    return this.#agent;
  }

  get localPds(): LocalPds | null {
    return this.#localPds;
  }

  async init() {
    try {
      // Boot the in-browser PDS — no OAuth sign-in required.
      this.#localPds = await startLocalPds();
      this.did = this.#localPds.did;
      this.handle = this.#localPds.did; // use DID as pseudo-handle
      console.log('[auth] local PDS ready, did:', this.did);
    } catch (e) {
      this.error = `Local PDS boot failed: ${String(e)}`;
    } finally {
      this.loading = false;
    }

    // Also initialize OAuth client for optional Bluesky sign-in.
    try {
      this.#oac = await BrowserOAuthClient.load({
        clientId: await buildClientId(),
        handleResolver: 'https://bsky.social',
      });
      const result = await this.#oac.init();
      if (result) {
        const { session } = result;
        this.#agent = new Agent(session);
        const res = await this.#agent.com.atproto.server.getSession();
        if (!res.success) throw new Error(JSON.stringify(res));
        this.handle = res.data.handle;
        this.did = res.data.did;
        console.log('[auth] OAuth session ready, handle:', this.handle);
      }
    } catch {
      // OAuth is optional — local PDS is sufficient.
    }
  }

  async signIn(identifier: string) {
    if (!this.#oac) return;
    this.loginBusy = true;
    this.loginError = null;
    try {
      await this.#oac.signIn(identifier, {
        state: 'compute-spa',
        signal: new AbortController().signal,
      });
    } catch (e) {
      this.loginError = String(e);
    } finally {
      this.loginBusy = false;
    }
  }

  async signOut() {
    if (!this.#oac || !this.did) return;
    await this.#oac.revoke(this.did);
    this.handle = this.#localPds?.did ?? null;
    this.did = this.#localPds?.did ?? null;
    this.#agent = null;
  }
}

export const auth = new AuthState();
