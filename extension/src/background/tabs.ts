// The agent workspace: a Chrome tab group titled "UABC". Agents can only see
// and act on tabs inside it; the user shares a tab by dragging it into the
// group and revokes access by dragging it out (ADR-0004).

export const GROUP_TITLE = 'UABC';
let cachedGroupId: number | undefined;

export async function agentGroup(): Promise<chrome.tabGroups.TabGroup | null> {
  if (cachedGroupId !== undefined) {
    try {
      return await chrome.tabGroups.get(cachedGroupId);
    } catch {
      cachedGroupId = undefined;
    }
  }
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  cachedGroupId = group?.id;
  return group ?? null;
}

export async function sharedTabs(): Promise<chrome.tabs.Tab[]> {
  const group = await agentGroup();
  return group ? chrome.tabs.query({ groupId: group.id }) : [];
}

export async function isShared(tab: chrome.tabs.Tab): Promise<boolean> {
  const group = await agentGroup();
  return !!group && tab.groupId === group.id;
}

export async function share(tabId: number): Promise<void> {
  const group = await agentGroup();
  if (group) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
    return;
  }
  const id = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(id, { title: GROUP_TITLE, color: 'cyan', collapsed: false });
  cachedGroupId = id;
}

export async function unshare(tabId: number): Promise<void> {
  await chrome.tabs.ungroup(tabId);
}

export async function openTab(url: string, active: boolean): Promise<chrome.tabs.Tab> {
  const group = await agentGroup();
  let windowId = group?.windowId;
  if (windowId === undefined) {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined))?.id;
  }
  const tab =
    windowId !== undefined
      ? await chrome.tabs.create({ windowId, url, active })
      : (await chrome.windows.create({ url, focused: active }))?.tabs?.[0];
  if (tab?.id === undefined) throw new Error('could not open a tab');
  await share(tab.id);
  return tab;
}

/**
 * Tabs opened by an agent action (target=_blank links, window.open) join the
 * workspace. A tab merely opened *from* a shared tab by the user does not, so
 * we only adopt tabs created while an agent is acting on the opener (or
 * shortly after).
 */
const recentlyOpened: Array<{ tabId: number; opener: number; at: number }> = [];
const agentActivity = new Map<number, number>();
const ADOPT_WINDOW_MS = 5_000;

export function markAgentActivity(tabId: number): void {
  agentActivity.set(tabId, Date.now());
}

chrome.tabs.onRemoved.addListener((tabId) => agentActivity.delete(tabId));

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  const { id, openerTabId } = tab;
  if (Date.now() - (agentActivity.get(openerTabId) ?? 0) > ADOPT_WINDOW_MS) return;
  void (async () => {
    try {
      const opener = await chrome.tabs.get(openerTabId);
      if (!(await isShared(opener))) return;
      if (tab.groupId !== opener.groupId) await share(id);
      recentlyOpened.push({ tabId: id, opener: openerTabId, at: Date.now() });
      if (recentlyOpened.length > 20) recentlyOpened.shift();
    } catch {
      // opener closed meanwhile
    }
  })();
});

export function tabsOpenedBy(opener: number, since: number): number[] {
  return recentlyOpened.filter((r) => r.opener === opener && r.at >= since).map((r) => r.tabId);
}
