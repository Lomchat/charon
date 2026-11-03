'use client';
import {
  closeExplorerRoot, explorerRootLabels, selectExplorerRoot, type ExplorerRoots,
} from './explorerRoots';
import { IconFolder, IconFolderPlus } from './fileIcons';
import { tipAttrs } from './tooltipText';
import { normalizeWorkspacePath } from './workspaceScope';

/**
 * The folder tabs (`explorerRoots.ts`), pinned over the explorer, search and
 * git — the folder shown is the one all three work on. The workspace's own
 * folder first, never closable, then each folder opened with ＋; the strip
 * turns orange (`.away`) while another one is shown. Same item shape as the
 * main tab bar — a div holding a main button and a close button, a button
 * inside a button being invalid HTML.
 */
export default function ExplorerRootTabs({ vpsId, cwd, roots, onAdd }: {
  vpsId: string;
  cwd: string;
  roots: ExplorerRoots;
  /** Opens the "open a folder" modal. Absent: no ＋. */
  onAdd?: () => void;
}) {
  const home = normalizeWorkspacePath(cwd) ?? cwd;
  const labels = explorerRootLabels([home, ...roots.folders]);
  return (
    <div className={`tt-roots${roots.active ? ' away' : ''}`} role="tablist" aria-label="panel folders">
      {[null, ...roots.folders].map((folder) => {
        const path = folder ?? home;
        const on = roots.active === folder;
        const label = labels.get(path) ?? path;
        return (
          <div
            key={path}
            className={`tt-root-tab${on ? ' on' : ''}${folder ? '' : ' home'}`}
            onAuxClick={folder ? (e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              closeExplorerRoot(vpsId, cwd, folder);
            } : undefined}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className="tt-root-main"
              onClick={() => selectExplorerRoot(vpsId, cwd, folder)}
              title={label}
              {...tipAttrs({
                detail: [path, folder ? 'Files, search and git work here' : 'This workspace\'s own folder'],
                actions: [['Click', 'show it'], folder ? ['Middle-click', 'close'] : null],
              })}
            >
              <IconFolder />
              <span className="tt-root-name">{label}</span>
            </button>
            {folder && (
              <button
                type="button"
                className="tt-root-close"
                onClick={() => closeExplorerRoot(vpsId, cwd, folder)}
                title="close this folder tab"
                aria-label={`close ${label}`}
              >✕</button>
            )}
          </div>
        );
      })}
      {onAdd && (
        <button
          type="button"
          className="tt-root-add"
          onClick={onAdd}
          title="Open a folder"
          aria-label="open a folder"
          {...tipAttrs({ detail: ['Another folder of this server, in its own tab'] })}
        >
          <IconFolderPlus />
        </button>
      )}
    </div>
  );
}
