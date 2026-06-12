export const VM_NSID     = 'com.publicdomainrelay.temp.compute.vm';
export const RFP_NSID    = 'com.publicdomainrelay.temp.market.rfp';
export const ACCEPT_NSID = 'com.publicdomainrelay.temp.market.accept';
export const VOUCH_NSID  = 'sh.tangled.graph.vouch';

// VM ↔ browser-relay handshake
export const SSH_KEY_NSID    = 'com.fedproxy.sshPublicKey';
export const TTYD_CREDS_NSID = 'com.fedproxy.ttydCredentials';

// fedproxy hosts
export const FEDPROXY_HOST  = 'fedproxy.com';
export const XRPC_DISPATCHER_HOST = 'xrpc.fedproxy.com';

// ttyd login user baked into the VM cloud-init
export const TTYD_USERNAME = 'agent';

/** Sanitize an atproto handle into a DNS label segment (dots/slashes → dashes). */
export function handleToLabel(handle: string): string {
  return handle.replace(/[./]/g, '-').toLowerCase();
}

/** Strip the `did:plc:` prefix, yielding the bare PLC key. */
export function didPlcKey(did: string): string {
  return did.replace(/^did:plc:/, '');
}

/** fedproxy SERVICE name / terminal subdomain for a VM: `<role>--<handle-label>`. */
export function vmServiceName(vmRole: string, handle: string): string {
  return `${vmRole.trim()}--${handleToLabel(handle)}`;
}

/** URL the "Terminal" button opens once the VM is ready. */
export function terminalUrl(vmRole: string, handle: string): string {
  return `https://${vmServiceName(vmRole, handle)}.${FEDPROXY_HOST}`;
}
