const LS_KEY = 'compute-spa:vms';

export interface SavedVM {
  name: string;
  vmUri: string;
  rfpUri: string;
  acceptUri: string;
  bidUri: string;
  createdAt: string;
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
