import { workspaceScopeKey } from './workspaceScope';

export type WorkspacePanelTab = 'edits' | 'git' | 'tree' | 'search' | 'files' | 'calls';

type SavedPanel = {
  tab: WorkspacePanelTab;
  scroll: Partial<Record<WorkspacePanelTab, number>>;
};

const MAX_WORKSPACES = 60;
const memory = new Map<string, SavedPanel>();

function key(vpsId: string | null | undefined, cwd: string | null | undefined): string {
  return workspaceScopeKey(vpsId, cwd);
}

function touch(scope: string): SavedPanel {
  const saved = memory.get(scope) ?? { tab: 'tree', scroll: {} };
  memory.delete(scope);
  memory.set(scope, saved);
  while (memory.size > MAX_WORKSPACES) memory.delete(memory.keys().next().value!);
  return saved;
}

export function readWorkspacePanelTab(
  vpsId: string | null | undefined,
  cwd: string | null | undefined,
): WorkspacePanelTab {
  return touch(key(vpsId, cwd)).tab;
}

export function writeWorkspacePanelTab(
  vpsId: string | null | undefined,
  cwd: string | null | undefined,
  tab: WorkspacePanelTab,
): void {
  touch(key(vpsId, cwd)).tab = tab;
}

export function readWorkspacePanelScroll(
  vpsId: string | null | undefined,
  cwd: string | null | undefined,
  tab: WorkspacePanelTab,
): number {
  return touch(key(vpsId, cwd)).scroll[tab] ?? 0;
}

export function writeWorkspacePanelScroll(
  vpsId: string | null | undefined,
  cwd: string | null | undefined,
  tab: WorkspacePanelTab,
  top: number,
): void {
  touch(key(vpsId, cwd)).scroll[tab] = Math.max(0, top);
}

export function __resetWorkspacePanelState(): void {
  memory.clear();
}
