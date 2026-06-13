import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { runOnLoad } from './lib/local-pds.ts'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// On page load, boot the in-browser atproto PDS and mint a service-auth token.
// Heavy console logging lives in local-pds.ts so the flow is visible in devtools.
runOnLoad().catch((err) => console.error('[local-pds] page-load flow failed:', err))

export default app
