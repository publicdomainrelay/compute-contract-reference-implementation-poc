import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';

function buildClientId(): string {
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (isLocal) {
    return `http://localhost?${new URLSearchParams({
      scope: 'atproto',
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

  get agent(): Agent | null {
    return this.#agent;
  }

  async init() {
    try {
      this.#oac = await BrowserOAuthClient.load({
        clientId: buildClientId(),
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
      }
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
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
    this.handle = null;
    this.did = null;
    this.#agent = null;
  }
}

export const auth = new AuthState();
