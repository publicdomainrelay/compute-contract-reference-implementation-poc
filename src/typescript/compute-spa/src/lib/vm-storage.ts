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
  const next = [vm, ...current];
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}

export function removeVM(current: SavedVM[], vmUri: string): SavedVM[] {
  const next = current.filter((v) => v.vmUri !== vmUri);
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}
