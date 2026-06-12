export type TabName = 'dashboard' | 'live-graph';

export const HASH_TO_TAB: Record<string, TabName> = {
  '#/request-vm': 'dashboard',
  '#/live-graph': 'live-graph',
};

export const TAB_TO_HASH: Record<TabName, string> = {
  'dashboard': '#/request-vm',
  'live-graph': '#/live-graph',
};

export function tabFromHash(): TabName {
  const hash = window.location.hash || sessionStorage.getItem('activeHash') || '';
  return HASH_TO_TAB[hash] ?? 'live-graph';
}

export function navigateToHash(tab: TabName): void {
  const hash = TAB_TO_HASH[tab];
  window.location.hash = hash;
  sessionStorage.setItem('activeHash', hash);
}
