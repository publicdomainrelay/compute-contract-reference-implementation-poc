// Market registry + bidder settings persisted to localStorage.
// Users can toggle default registries/bidders on/off and add custom ones.
// Enabled entries are passed to requestVM() to override discovery defaults.

import { DEFAULT_REGISTRY_ENDPOINTS } from '@publicdomainrelay/market';

const STORAGE_KEY = 'market-settings';

// Default bidder DIDs always offered alongside discovered ones.
const DEFAULT_BIDDER_DIDS: string[] = ['did:plc:5svqtrhheairglgiiyvutzik'];

export interface ToggleEntry {
  value: string;  // endpoint URL or DID
  enabled: boolean;
  /** true when this entry came from code defaults (so it can't be removed, only toggled). */
  isDefault: boolean;
}

export interface MarketSettings {
  registries: ToggleEntry[];
  bidders: ToggleEntry[];
}

function defaults(): MarketSettings {
  return {
    registries: DEFAULT_REGISTRY_ENDPOINTS.map((e) => ({ value: e, enabled: true, isDefault: true })),
    bidders: DEFAULT_BIDDER_DIDS.map((d) => ({ value: d, enabled: true, isDefault: true })),
  };
}

function mergeWithDefaults(saved: MarketSettings): MarketSettings {
  const defs = defaults();

  // Merge registries: keep saved entries, add any new defaults not yet present.
  const savedRegValues = new Set(saved.registries.map((r) => r.value));
  for (const dr of defs.registries) {
    if (!savedRegValues.has(dr.value)) saved.registries.push(dr);
  }

  // Merge bidders: same logic.
  const savedBidValues = new Set(saved.bidders.map((b) => b.value));
  for (const db of defs.bidders) {
    if (!savedBidValues.has(db.value)) saved.bidders.push(db);
  }

  return saved;
}

export function loadMarketSettings(): MarketSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MarketSettings;
      if (parsed.registries && parsed.bidders) return mergeWithDefaults(parsed);
    }
  } catch { /* corrupt — use defaults */ }
  return defaults();
}

export function saveMarketSettings(s: MarketSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

/** Return only enabled registry endpoint values. */
export function enabledRegistries(s: MarketSettings): string[] {
  return s.registries.filter((r) => r.enabled).map((r) => r.value);
}

/** Return only enabled bidder DID values. */
export function enabledBidders(s: MarketSettings): string[] {
  return s.bidders.filter((b) => b.enabled).map((b) => b.value);
}

/** Toggle an entry's enabled flag by value. Returns new (mutated) settings. */
export function toggleEntry(s: MarketSettings, kind: 'registries' | 'bidders', value: string): MarketSettings {
  const list = s[kind];
  const entry = list.find((e) => e.value === value);
  if (entry) entry.enabled = !entry.enabled;
  return s;
}

/** Add a user-supplied entry (isDefault: false, enabled: true). No-op if duplicate. */
export function addEntry(s: MarketSettings, kind: 'registries' | 'bidders', value: string): MarketSettings {
  const list = s[kind];
  if (list.some((e) => e.value === value)) return s;
  list.push({ value, enabled: true, isDefault: false });
  return s;
}

/** Remove a user-supplied entry. Default entries cannot be removed. */
export function removeEntry(s: MarketSettings, kind: 'registries' | 'bidders', value: string): MarketSettings {
  const list = s[kind];
  const idx = list.findIndex((e) => e.value === value && !e.isDefault);
  if (idx >= 0) list.splice(idx, 1);
  return s;
}
