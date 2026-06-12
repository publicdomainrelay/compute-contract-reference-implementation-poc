const STORAGE_KEY = 'market-graph-recordings';

export interface StoredSession {
  id: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  events: unknown[];
  importedAt?: string;
}

export function getRecordings(): StoredSession[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}

export function setRecordings(arr: StoredSession[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}

export function downloadStoredSession(stored: StoredSession): void {
  const blob = new Blob([JSON.stringify(stored, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `market-graph-${stored.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseImportData(data: unknown): StoredSession[] {
  const items = Array.isArray(data) ? data : [data];
  const result: StoredSession[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (!obj['events'] || !Array.isArray(obj['events'])) continue;
    if (!obj['id']) obj['id'] = Date.now().toString(36) + '_' + result.length;
    obj['importedAt'] = new Date().toISOString();
    result.push(obj as unknown as StoredSession);
  }
  return result;
}
