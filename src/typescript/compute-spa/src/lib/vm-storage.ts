const LS_KEY = 'compute-spa:vms';

export interface SavedVM {
  name: string;
  vmUri: string;
  rfpUri: string;
  acceptUri: string;
  bidUri: string;
  createdAt: string;
  receiptUri?: string;
  receiptCid?: string;
  submitEventRef?: string;
  /** com.fedproxy.rbac record URI created to authorize this VM. */
  rbacUri?: string;
  /** fedproxy SERVICE name / terminal subdomain (`<role>--<handle-label>`). */
  serviceName?: string;
  /** ttyd login password generated client-side, handed to the VM via the relay. */
  ttydPassword?: string;
}

export function loadSavedVMs(): SavedVM[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function persistVM(current: SavedVM[], vm: SavedVM): SavedVM[] {
  // Dedupe by VM name: a re-request of the same name supersedes the old entry.
  // The ttyd handshake map (relayClient.#ttydRequests) is keyed by vmName, and
  // the savedVMs $effect re-registers every saved VM on reload — a leftover
  // duplicate with a stale ttydPassword would clobber the fresh one (last write
  // wins), making the VM serve an old token → "terminal auth bootstrap 401".
  const next = [vm, ...current.filter((v) => v.name !== vm.name)];
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}

export function removeVM(current: SavedVM[], vmUri: string): SavedVM[] {
  const next = current.filter((v) => v.vmUri !== vmUri);
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}
