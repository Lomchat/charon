/**
 * Browser workspace identity shared by the tab row and both sidebars.
 *
 * An agent session, an SSH shell and a file are different entities, but when
 * they point at the same folder on the same VPS they are views of one
 * workspace.  Keep this tiny helper provider-neutral so every surface uses
 * exactly the same equality rule.
 */

export type WorkspaceScope = { vpsId: string; path: string };

export function normalizeWorkspacePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '') || '/';
}

export function workspaceScopeKey(vpsId: string | null | undefined, path: string | null | undefined): string {
  const normalized = normalizeWorkspacePath(path) ?? '';
  return `${vpsId ?? ''}\u0000${normalized}`;
}

export function isSameWorkspace(
  active: WorkspaceScope | null | undefined,
  vpsId: string | null | undefined,
  path: string | null | undefined,
): boolean {
  if (!active || active.vpsId !== vpsId) return false;
  const activePath = normalizeWorkspacePath(active.path);
  const candidatePath = normalizeWorkspacePath(path);
  return activePath !== null && activePath === candidatePath;
}
