'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import LoginConsole from './LoginConsole';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type Props = {
  onClose: () => void;
  initialVps: Vps[];
  initialFolders: VpsFolder[];
  initialPaths: VpsPath[];
  onChange?: (next: { vps: Vps[]; folders: VpsFolder[]; paths: VpsPath[] }) => void;
  // "install agent" button on a VPS card: closes the modal and delegates to
  // ClaudePanel which opens an install session (cf. ClaudePanel.openInstallSession).
  // Before: opened a BootstrapBanner overlay INSIDE the modal, but it stacked
  // overlays and blocked access to the rest of the hub during the install.
  onInstallAgent?: (vps: Vps) => void;
};

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:      { glyph: '●', label: 'agent ok' },
  missing: { glyph: '○', label: 'agent not installed' },
  error:   { glyph: '◐', label: 'agent in error' },
  unknown: { glyph: '?', label: 'agent untested' },
};

const DEFAULT_FOLDER_ID = 'default';

// Drag-and-drop identifiers: we encode the type so we can distinguish a
// drop on a VPS card (= adjacent insertion) from a drop on a folder's zone
// (= append). We use the prefixes `folder:<id>` and `vps:<id>`.
//   - VPSes are sortable intra-folder AND draggable to another folder.
//   - Folders (the whole block) are sortable among themselves.
// The "drop in the folder" area (= droppable id `folder-drop:<id>`) captures
// VPSes dropped on the folder's empty space (not on a specific card).
function vpsDragId(id: string) { return `vps:${id}`; }
function folderDragId(id: string) { return `folder:${id}`; }
function folderDropZoneId(id: string) { return `folder-drop:${id}`; }
function decodeId(dragId: string): { kind: 'vps' | 'folder' | 'folder-drop'; id: string } {
  if (dragId.startsWith('vps:')) return { kind: 'vps', id: dragId.slice(4) };
  if (dragId.startsWith('folder:')) return { kind: 'folder', id: dragId.slice(7) };
  if (dragId.startsWith('folder-drop:')) return { kind: 'folder-drop', id: dragId.slice(12) };
  return { kind: 'vps', id: dragId };
}

export default function DataModal({ onClose, initialVps, initialFolders, initialPaths, onChange, onInstallAgent }: Props) {
  const [vpsList, setVpsList] = useState<Vps[]>(initialVps);
  const [folders, setFolders] = useState<VpsFolder[]>(initialFolders);
  const [paths, setPaths] = useState<VpsPath[]>(initialPaths);
  const [err, setErr] = useState<string | null>(null);
  const [loginVps, setLoginVps] = useState<Vps | null>(null);
  const [addVpsOpen, setAddVpsOpen] = useState(false);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  // Per-VPS inline form state for adding a path
  const [pathInputs, setPathInputs] = useState<Record<string, { path: string; label: string }>>({});
  // Current drag-and-drop ID (for DragOverlay)
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Handler for the "install" button: closes the modal and delegates. If no
  // callback is provided (legacy or test case), silent no-op.
  const handleBootstrap = useCallback((v: Vps) => {
    if (!onInstallAgent) return;
    onClose();
    onInstallAgent(v);
  }, [onClose, onInstallAgent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loginVps) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, loginVps]);

  function notify(nextVps?: Vps[], nextFolders?: VpsFolder[], nextPaths?: VpsPath[]) {
    onChange?.({
      vps: nextVps ?? vpsList,
      folders: nextFolders ?? folders,
      paths: nextPaths ?? paths,
    });
  }

  // ─── Sorted folders & grouped VPSes ──────────────────────
  // "Default last" rule: the 'default' folder (Unfiled) is always at the
  // very bottom, regardless of its stored `position`. The rest is sorted
  // by increasing position. This rule is applied on the UI side but also
  // maintained on the API side (createVpsFolder pushes default to max+1
  // after each insertion).
  const sortedFolders = useMemo(() => {
    return [...folders].sort((a, b) => {
      if (a.id === DEFAULT_FOLDER_ID) return 1;
      if (b.id === DEFAULT_FOLDER_ID) return -1;
      return a.position - b.position;
    });
  }, [folders]);
  // Draggable folders (= all except 'default')
  const draggableFolders = useMemo(
    () => sortedFolders.filter((f) => f.id !== DEFAULT_FOLDER_ID),
    [sortedFolders],
  );
  const defaultFolder = useMemo(
    () => sortedFolders.find((f) => f.id === DEFAULT_FOLDER_ID) ?? null,
    [sortedFolders],
  );
  const vpsByFolder = useMemo(() => {
    const m = new Map<string, Vps[]>();
    for (const v of vpsList) {
      const arr = m.get(v.folderId) ?? [];
      arr.push(v);
      m.set(v.folderId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [vpsList]);

  // ─── VPS CRUD ────────────────────────────────────────
  const [vpsForm, setVpsForm] = useState({ name: '', ip: '', sshUser: 'root', sshPort: '22', defaultPath: '', folderId: DEFAULT_FOLDER_ID });
  async function addVps() {
    setErr(null);
    if (!vpsForm.name.trim() || !vpsForm.ip.trim() || !vpsForm.sshUser.trim()) {
      setErr('name, ip and user required');
      return;
    }
    try {
      const row = await api.createVps({
        name: vpsForm.name.trim(),
        ip: vpsForm.ip.trim(),
        sshUser: vpsForm.sshUser.trim(),
        sshPort: Number(vpsForm.sshPort) || 22,
        defaultPath: vpsForm.defaultPath.trim() || null,
        folderId: vpsForm.folderId || DEFAULT_FOLDER_ID,
      });
      const next = [...vpsList, row];
      setVpsList(next);
      notify(next);
      setVpsForm({ name: '', ip: '', sshUser: 'root', sshPort: '22', defaultPath: '', folderId: vpsForm.folderId });
      setAddVpsOpen(false);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deleteVps(id: string, name: string) {
    if (!confirm(`Delete ${name}?\nIts paths and sessions will also be deleted.`)) return;
    try {
      await api.deleteVps(id);
      const nextVps = vpsList.filter((v) => v.id !== id);
      const nextPaths = paths.filter((p) => p.vpsId !== id);
      setVpsList(nextVps); setPaths(nextPaths);
      notify(nextVps, undefined, nextPaths);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  // ─── Folders CRUD ────────────────────────────────────
  async function addFolder() {
    setErr(null);
    const name = newFolderName.trim();
    if (!name) { setErr('name required'); return; }
    try {
      const row = await api.createVpsFolder({ name });
      const next = [...folders, row];
      setFolders(next);
      notify(undefined, next);
      setNewFolderName('');
      setAddFolderOpen(false);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function renameFolder(id: string, name: string) {
    try {
      const updated = await api.updateVpsFolder(id, { name });
      const next = folders.map((f) => f.id === id ? updated : f);
      setFolders(next); notify(undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deleteFolder(id: string, name: string) {
    if (id === DEFAULT_FOLDER_ID) { setErr('the default folder cannot be deleted'); return; }
    const inside = vpsByFolder.get(id) ?? [];
    const msg = inside.length > 0
      ? `Delete folder "${name}"?\nIts ${inside.length} VPS will be moved to "No folder".`
      : `Delete folder "${name}"?`;
    if (!confirm(msg)) return;
    try {
      await api.deleteVpsFolder(id);
      const nextFolders = folders.filter((f) => f.id !== id);
      // Local side: move the VPSes to the default folder (positions at the end)
      let movedVps = vpsList;
      if (inside.length > 0) {
        const existing = vpsByFolder.get(DEFAULT_FOLDER_ID) ?? [];
        let nextPos = existing.length;
        const movedIds = new Set(inside.map((v) => v.id));
        movedVps = vpsList.map((v) => movedIds.has(v.id)
          ? { ...v, folderId: DEFAULT_FOLDER_ID, position: nextPos++ }
          : v,
        );
      }
      setFolders(nextFolders); setVpsList(movedVps);
      notify(movedVps, nextFolders);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  // ─── Paths CRUD ──────────────────────────────────────
  async function addPath(vpsId: string) {
    setErr(null);
    const form = pathInputs[vpsId] ?? { path: '', label: '' };
    if (!form.path.trim()) { setErr('path required'); return; }
    try {
      const row = await api.createVpsPath({
        vpsId, path: form.path.trim(), label: form.label.trim() || null,
      });
      const next = paths.some((p) => p.id === row.id)
        ? paths.map((p) => (p.id === row.id ? row : p))
        : [...paths, row];
      setPaths(next);
      notify(undefined, undefined, next);
      setPathInputs((prev) => ({ ...prev, [vpsId]: { path: '', label: '' } }));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deletePath(id: number) {
    try {
      await api.deleteVpsPath(id);
      const next = paths.filter((p) => p.id !== id);
      setPaths(next); notify(undefined, undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function updatePathLabel(id: number, label: string) {
    try {
      const updated = await api.updateVpsPath(id, { label: label.trim() || null });
      const next = paths.map((p) => (p.id === id ? updated : p));
      setPaths(next); notify(undefined, undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  function setPathInput(vpsId: string, field: 'path' | 'label', value: string) {
    setPathInputs((prev) => ({
      ...prev,
      [vpsId]: { path: prev[vpsId]?.path ?? '', label: prev[vpsId]?.label ?? '', [field]: value },
    }));
  }

  // ─── Move a VPS to another folder (via select) ──────────────────────
  // Called by the `<select>` in each VPS card. The logic is the same as
  // the drag-end "drop on folder body": we remove the VPS from its
  // current folder and append it to the end of the new folder. Optimistic
  // on the state side, followed by an atomic POST.
  const moveVpsToFolder = useCallback((vpsId: string, newFolderId: string) => {
    const moved = vpsList.find((v) => v.id === vpsId);
    if (!moved) return;
    if (moved.folderId === newFolderId) return;

    const groups = new Map<string, Vps[]>();
    for (const f of sortedFolders) {
      groups.set(f.id, [...(vpsByFolder.get(f.id) ?? []).filter((v) => v.id !== vpsId)]);
    }
    if (!groups.has(newFolderId)) groups.set(newFolderId, []);
    groups.get(newFolderId)!.push({ ...moved, folderId: newFolderId });

    const flat: Vps[] = [];
    for (const f of sortedFolders) {
      const arr = groups.get(f.id) ?? [];
      for (let i = 0; i < arr.length; i++) flat.push({ ...arr[i], position: i });
    }
    // VPSes in unknown folders (orphans): we leave them as-is.
    const known = new Set(sortedFolders.map((f) => f.id));
    for (const v of vpsList) {
      if (!known.has(v.folderId) && v.id !== vpsId) flat.push(v);
    }
    setVpsList(flat);
    persistLayout(sortedFolders, flat);
  }, [vpsList, sortedFolders, vpsByFolder]); // eslint-disable-line

  // ─── Persisting a re-layout (drag-end) ───────────────
  // Builds the complete state (positions of all folders + folderId/position
  // of all VPSes) from the local React state, then sends it via POST.
  const persistLayout = useCallback(async (
    nextFolders: VpsFolder[],
    nextVps: Vps[],
  ) => {
    try {
      const res = await api.applyVpsLayout({
        folders: nextFolders.map((f, idx) => ({ id: f.id, position: idx })),
        vps: nextVps.map((v) => ({ id: v.id, folderId: v.folderId, position: v.position })),
      });
      // Resync from the server (in case a VPS was created in the meantime).
      setFolders(res.folders);
      setVpsList(res.vps);
      notify(res.vps, res.folders);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, [notify]);

  // ─── DnD ─────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Prevents a simple button click in a VPS card from triggering an
      // accidental drag — a 6px drag is required to activate.
      activationConstraint: { distance: 6 },
    }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function handleDragOver(_e: DragOverEvent) {
    // No-op: we compute everything at drag-end (no cross-container live preview
    // — expensive to animate for marginal UX gain on this list).
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over) return;
    const a = decodeId(String(active.id));
    const o = decodeId(String(over.id));
    if (active.id === over.id) return;

    // 1) Folder reordering. Only the draggable folders (= non-default)
    //    participate. 'default' always stays last (rendered outside the
    //    SortableContext, so it cannot be a drop target for folder-drag).
    if (a.kind === 'folder' && o.kind === 'folder') {
      if (a.id === DEFAULT_FOLDER_ID || o.id === DEFAULT_FOLDER_ID) return;
      const oldIdx = draggableFolders.findIndex((f) => f.id === a.id);
      const newIdx = draggableFolders.findIndex((f) => f.id === o.id);
      if (oldIdx < 0 || newIdx < 0) return;
      const reordered = arrayMove(draggableFolders, oldIdx, newIdx).map((f, i) => ({ ...f, position: i }));
      // Rebuild the folders state: non-default reordered + default at the end.
      const next = defaultFolder
        ? [...reordered, { ...defaultFolder, position: reordered.length }]
        : reordered;
      setFolders(next);
      persistLayout(next, vpsList);
      return;
    }

    // 2) Reorder / move a VPS
    if (a.kind === 'vps') {
      const movedVps = vpsList.find((v) => v.id === a.id);
      if (!movedVps) return;

      // Target: either another VPS card, or a folder's zone
      let targetFolderId: string;
      let targetIndex: number;
      if (o.kind === 'vps') {
        const target = vpsList.find((v) => v.id === o.id);
        if (!target) return;
        targetFolderId = target.folderId;
        const inFolder = (vpsByFolder.get(targetFolderId) ?? []).filter((v) => v.id !== a.id);
        const idxInFolder = inFolder.findIndex((v) => v.id === o.id);
        targetIndex = idxInFolder < 0 ? inFolder.length : idxInFolder;
      } else if (o.kind === 'folder-drop' || o.kind === 'folder') {
        targetFolderId = o.id;
        const inFolder = (vpsByFolder.get(targetFolderId) ?? []).filter((v) => v.id !== a.id);
        targetIndex = inFolder.length; // append at the end
      } else {
        return;
      }

      // Rebuild all intra-folder positions starting from the current
      // groups, by removing the moved VPS and inserting it at targetIndex
      // in the target folder.
      const groups = new Map<string, Vps[]>();
      for (const f of sortedFolders) groups.set(f.id, [...(vpsByFolder.get(f.id) ?? []).filter((v) => v.id !== a.id)]);
      // In case the folder isn't in `groups` (data drift), fallback
      if (!groups.has(targetFolderId)) groups.set(targetFolderId, []);
      const tgt = groups.get(targetFolderId)!;
      const moved = { ...movedVps, folderId: targetFolderId };
      tgt.splice(Math.min(targetIndex, tgt.length), 0, moved);

      // Flatten into a new list with normalized positions
      const flat: Vps[] = [];
      for (const f of sortedFolders) {
        const arr = groups.get(f.id) ?? [];
        for (let i = 0; i < arr.length; i++) {
          flat.push({ ...arr[i], position: i });
        }
      }
      // VPS dont le folderId est inconnu (orphelins) : on les laisse comme avant
      const known = new Set(sortedFolders.map((f) => f.id));
      for (const v of vpsList) {
        if (!known.has(v.folderId) && v.id !== a.id) flat.push(v);
      }
      setVpsList(flat);
      persistLayout(sortedFolders, flat);
      return;
    }
  }

  // ─── Render ──────────────────────────────────────────
  const activeDecoded = activeDragId ? decodeId(activeDragId) : null;
  const activeVps = activeDecoded?.kind === 'vps'
    ? vpsList.find((v) => v.id === activeDecoded.id) ?? null
    : null;
  const activeFolder = activeDecoded?.kind === 'folder'
    ? folders.find((f) => f.id === activeDecoded.id) ?? null
    : null;

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal data-modal data-modal-v2">
        <button className="modal-close" onClick={onClose}>✕</button>
        <header className="data-head">
          <h2>VPS & paths</h2>
          <div className="data-head-actions">
            <button
              className="data-add-vps-btn"
              onClick={() => { setAddFolderOpen(!addFolderOpen); setAddVpsOpen(false); }}
            >{addFolderOpen ? '− cancel' : '+ folder'}</button>
            <button
              className="data-add-vps-btn"
              onClick={() => { setAddVpsOpen(!addVpsOpen); setAddFolderOpen(false); }}
            >{addVpsOpen ? '− cancel' : '+ VPS'}</button>
          </div>
        </header>
        <p className="data-help">
          Drag folders to reorder them, or a VPS to move it to another folder (or change its order).
        </p>

        {err && <div className="data-err">{err}</div>}

        {addFolderOpen && (
          <div className="data-add data-add-folder">
            <input
              placeholder="folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addFolder(); else if (e.key === 'Escape') setAddFolderOpen(false); }}
              autoFocus
            />
            <button className="primary" onClick={addFolder} disabled={!newFolderName.trim()}>create</button>
          </div>
        )}

        {addVpsOpen && (
          <div className="data-add data-add-vps">
            <input placeholder="name" value={vpsForm.name} onChange={(e) => setVpsForm({ ...vpsForm, name: e.target.value })} autoFocus />
            <input placeholder="ip or hostname" value={vpsForm.ip} onChange={(e) => setVpsForm({ ...vpsForm, ip: e.target.value })} />
            <input placeholder="ssh user" value={vpsForm.sshUser} onChange={(e) => setVpsForm({ ...vpsForm, sshUser: e.target.value })} style={{ maxWidth: 100 }} />
            <input placeholder="port" value={vpsForm.sshPort} onChange={(e) => setVpsForm({ ...vpsForm, sshPort: e.target.value })} style={{ maxWidth: 60 }} inputMode="numeric" />
            <input placeholder="default path (opt.)" value={vpsForm.defaultPath} onChange={(e) => setVpsForm({ ...vpsForm, defaultPath: e.target.value })} />
            <select
              value={vpsForm.folderId}
              onChange={(e) => setVpsForm({ ...vpsForm, folderId: e.target.value })}
              title="target folder"
            >
              {sortedFolders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <button className="primary" onClick={addVps}>create</button>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="data-folder-list">
            {sortedFolders.length === 0 && (
              <div className="data-empty">no folders — click on « + folder » to start</div>
            )}
            {/* Draggable folders: reorderable among themselves via DnD */}
            <SortableContext
              items={draggableFolders.map((f) => folderDragId(f.id))}
              strategy={verticalListSortingStrategy}
            >
              {draggableFolders.map((folder) => (
                <SortableFolder
                  key={folder.id}
                  folder={folder}
                  vps={vpsByFolder.get(folder.id) ?? []}
                  allFolders={sortedFolders}
                  paths={paths}
                  pathInputs={pathInputs}
                  onRename={(name) => renameFolder(folder.id, name)}
                  onDelete={() => deleteFolder(folder.id, folder.name)}
                  onBootstrap={handleBootstrap}
                  onLogin={(v) => setLoginVps(v)}
                  onDeleteVps={(id, name) => deleteVps(id, name)}
                  onChangeVpsFolder={(vpsId, newFolderId) => moveVpsToFolder(vpsId, newFolderId)}
                  onAddPath={(vpsId) => addPath(vpsId)}
                  onDeletePath={(id) => deletePath(id)}
                  onUpdatePathLabel={(id, label) => updatePathLabel(id, label)}
                  onSetPathInput={setPathInput}
                />
              ))}
            </SortableContext>
            {/* 'default' folder: rendered outside the SortableContext so
                non-draggable as a folder. But its zone (droppable) still
                accepts VPSes dragged into it, and its VPS content remains
                sortable intra-folder. */}
            {defaultFolder && (
              <StaticFolder
                folder={defaultFolder}
                vps={vpsByFolder.get(defaultFolder.id) ?? []}
                allFolders={sortedFolders}
                paths={paths}
                pathInputs={pathInputs}
                onBootstrap={handleBootstrap}
                onLogin={(v) => setLoginVps(v)}
                onDeleteVps={(id, name) => deleteVps(id, name)}
                onChangeVpsFolder={(vpsId, newFolderId) => moveVpsToFolder(vpsId, newFolderId)}
                onAddPath={(vpsId) => addPath(vpsId)}
                onDeletePath={(id) => deletePath(id)}
                onUpdatePathLabel={(id, label) => updatePathLabel(id, label)}
                onSetPathInput={setPathInput}
              />
            )}
          </div>
          <DragOverlay>
            {activeVps ? (
              <div className="dv-card-drag-overlay">
                <span className="dv-glyph">▣</span>
                <span className="dv-name">{activeVps.name}</span>
                <span className="dv-host">{activeVps.sshUser}@{activeVps.ip}</span>
              </div>
            ) : activeFolder ? (
              <div className="dv-folder-drag-overlay">
                <span>▤ {activeFolder.name}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      {loginVps && (
        <LoginConsole vps={loginVps} onClose={() => setLoginVps(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SortableFolder : un dossier draggable qui contient une liste de VPS
// draggables. La zone "droppable folder" capture les drops de VPS qui
// tombent sur le header / l'espace vide du dossier (pas sur une carte VPS).
// ─────────────────────────────────────────────────────────────
function SortableFolder({
  folder, vps, allFolders, paths, pathInputs,
  onRename, onDelete,
  onBootstrap, onLogin, onDeleteVps, onChangeVpsFolder,
  onAddPath, onDeletePath, onUpdatePathLabel, onSetPathInput,
}: {
  folder: VpsFolder;
  vps: Vps[];
  allFolders: VpsFolder[];
  paths: VpsPath[];
  pathInputs: Record<string, { path: string; label: string }>;
  onRename: (name: string) => void;
  onDelete: () => void;
  onBootstrap: (v: Vps) => void;
  onLogin: (v: Vps) => void;
  onDeleteVps: (id: string, name: string) => void;
  onChangeVpsFolder: (vpsId: string, newFolderId: string) => void;
  onAddPath: (vpsId: string) => void;
  onDeletePath: (id: number) => void;
  onUpdatePathLabel: (id: number, label: string) => void;
  onSetPathInput: (vpsId: string, field: 'path' | 'label', value: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    setDroppableNodeRef,
  } = useSortableWithDroppable(folder.id);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      className={`data-folder-card${isDragging ? ' is-dragging' : ''}`}
      {...attributes}
    >
      <header className="data-folder-head">
        <span className="data-folder-drag-handle" {...listeners} title="drag to reorder folders">⋮⋮</span>
        <span className="data-folder-glyph">▤</span>
        <FolderRenameInput initial={folder.name} onSubmit={onRename} />
        <span className="data-folder-count">{vps.length} VPS</span>
        {folder.id !== DEFAULT_FOLDER_ID && (
          <button className="dv-btn danger" onClick={onDelete} title="delete this folder">✕</button>
        )}
      </header>
      <div ref={setDroppableNodeRef} className="data-folder-body">
        <SortableContext
          items={vps.map((v) => vpsDragId(v.id))}
          strategy={verticalListSortingStrategy}
        >
          {vps.length === 0 && (
            <div className="data-folder-empty">empty — drag a VPS here</div>
          )}
          {vps.map((v) => (
            <SortableVpsCard
              key={v.id}
              v={v}
              allFolders={allFolders}
              paths={paths}
              pathInput={pathInputs[v.id] ?? { path: '', label: '' }}
              onBootstrap={() => onBootstrap(v)}
              onLogin={() => onLogin(v)}
              onDelete={() => onDeleteVps(v.id, v.name)}
              onChangeFolder={(newFolderId) => onChangeVpsFolder(v.id, newFolderId)}
              onAddPath={() => onAddPath(v.id)}
              onDeletePath={onDeletePath}
              onUpdatePathLabel={onUpdatePathLabel}
              onSetPathInput={(field, value) => onSetPathInput(v.id, field, value)}
            />
          ))}
        </SortableContext>
      </div>
    </section>
  );
}

// Utility hook: combines useSortable (to reorder folders among themselves)
// with a separate useDroppable on the folder body (to accept VPSes
// dropped on the folder's empty space). The two refs are applied to
// different DOM nodes (section for the sortable, body for the droppable).
function useSortableWithDroppable(folderId: string) {
  const sortable = useSortable({ id: folderDragId(folderId) });
  const droppable = useDroppable({ id: folderDropZoneId(folderId) });
  return { ...sortable, setDroppableNodeRef: droppable.setNodeRef };
}

function FolderRenameInput({ initial, onSubmit }: { initial: string; onSubmit: (name: string) => void }) {
  const [val, setVal] = useState(initial);
  useEffect(() => { setVal(initial); }, [initial]);
  return (
    <input
      className="data-folder-name-input"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setVal(initial);
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={() => {
        const trimmed = val.trim();
        if (trimmed && trimmed !== initial) onSubmit(trimmed);
        else setVal(initial);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// StaticFolder: non-draggable variant of SortableFolder, used for the
// 'default' folder which is locked in last position. No drag handle, no
// delete button. The body remains droppable so VPSes can be dropped into
// it, and the internal SortableContext allows reordering the VPSes that
// live there.
// ─────────────────────────────────────────────────────────────
function StaticFolder({
  folder, vps, allFolders, paths, pathInputs,
  onBootstrap, onLogin, onDeleteVps, onChangeVpsFolder,
  onAddPath, onDeletePath, onUpdatePathLabel, onSetPathInput,
}: {
  folder: VpsFolder;
  vps: Vps[];
  allFolders: VpsFolder[];
  paths: VpsPath[];
  pathInputs: Record<string, { path: string; label: string }>;
  onBootstrap: (v: Vps) => void;
  onLogin: (v: Vps) => void;
  onDeleteVps: (id: string, name: string) => void;
  onChangeVpsFolder: (vpsId: string, newFolderId: string) => void;
  onAddPath: (vpsId: string) => void;
  onDeletePath: (id: number) => void;
  onUpdatePathLabel: (id: number, label: string) => void;
  onSetPathInput: (vpsId: string, field: 'path' | 'label', value: string) => void;
}) {
  // The body is droppable so we can drop VPSes into it at drag-end.
  const { setNodeRef: setBodyRef } = useDroppable({ id: folderDropZoneId(folder.id) });
  return (
    <section className="data-folder-card data-folder-static">
      <header className="data-folder-head">
        {/* No drag handle here: this folder is locked in last position */}
        <span className="data-folder-lock" title="folder locked in last position">🔒</span>
        <span className="data-folder-glyph">▤</span>
        <span className="data-folder-name-static">{folder.name}</span>
        <span className="data-folder-count">{vps.length} VPS</span>
      </header>
      <div ref={setBodyRef} className="data-folder-body">
        <SortableContext
          items={vps.map((v) => vpsDragId(v.id))}
          strategy={verticalListSortingStrategy}
        >
          {vps.length === 0 && (
            <div className="data-folder-empty">empty — drag a VPS here or use the select next to a VPS</div>
          )}
          {vps.map((v) => (
            <SortableVpsCard
              key={v.id}
              v={v}
              allFolders={allFolders}
              paths={paths}
              pathInput={pathInputs[v.id] ?? { path: '', label: '' }}
              onBootstrap={() => onBootstrap(v)}
              onLogin={() => onLogin(v)}
              onDelete={() => onDeleteVps(v.id, v.name)}
              onChangeFolder={(newFolderId) => onChangeVpsFolder(v.id, newFolderId)}
              onAddPath={() => onAddPath(v.id)}
              onDeletePath={onDeletePath}
              onUpdatePathLabel={onUpdatePathLabel}
              onSetPathInput={(field, value) => onSetPathInput(v.id, field, value)}
            />
          ))}
        </SortableContext>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// SortableVpsCard: a draggable VPS card. The drag is triggered by the
// handle (⋮⋮) so the inputs/buttons remain clickable without risk of
// misinterpretation.
// ─────────────────────────────────────────────────────────────
function SortableVpsCard({
  v, allFolders, paths, pathInput,
  onBootstrap, onLogin, onDelete, onChangeFolder,
  onAddPath, onDeletePath, onUpdatePathLabel, onSetPathInput,
}: {
  v: Vps;
  allFolders: VpsFolder[];
  paths: VpsPath[];
  pathInput: { path: string; label: string };
  onBootstrap: () => void;
  onLogin: () => void;
  onDelete: () => void;
  onChangeFolder: (newFolderId: string) => void;
  onAddPath: () => void;
  onDeletePath: (id: number) => void;
  onUpdatePathLabel: (id: number, label: string) => void;
  onSetPathInput: (field: 'path' | 'label', value: string) => void;
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: vpsDragId(v.id) });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const status = (v as any).agentStatus ?? 'unknown';
  const version = (v as any).agentVersion as string | undefined;
  const meta = AGENT_BADGE[status] ?? AGENT_BADGE.unknown;
  const vpsPathsRows = paths.filter((p) => p.vpsId === v.id)
    .sort((a, b) => (a.label ?? a.path).localeCompare(b.label ?? b.path));

  return (
    <section ref={setNodeRef} style={style} className={`data-vps-card agent-${status}${isDragging ? ' is-dragging' : ''}`} {...attributes}>
      <header className="data-vps-head">
        <span className="data-vps-drag-handle" {...listeners} title="drag to reorder or move to another folder">⋮⋮</span>
        <span className="dv-glyph">▣</span>
        <span className="dv-name">{v.name}</span>
        <span className="dv-host">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
        <span className={`dv-agent agent-${status}`} title={meta.label + (version ? ` (v${version})` : '')}>
          {meta.glyph}<span className="dv-agent-text">{meta.label}</span>
        </span>
        <select
          className="dv-folder-select"
          value={v.folderId}
          onChange={(e) => onChangeFolder(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          title="change folder"
        >
          {allFolders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <div className="dv-actions">
          {status !== 'ok' && (
            <button className="dv-btn primary" onClick={onBootstrap}>install</button>
          )}
          <button className="dv-btn" onClick={onLogin}>login</button>
          <button className="dv-btn danger" onClick={onDelete} title="delete this VPS">✕</button>
        </div>
      </header>
      <div className="data-vps-paths">
        {vpsPathsRows.length === 0 && (
          <div className="dv-empty">no paths registered for this VPS</div>
        )}
        {vpsPathsRows.map((p) => (
          <div key={p.id} className="dv-path-row">
            <span className="dv-path-glyph">▤</span>
            <input
              className="dv-path-label"
              defaultValue={p.label ?? ''}
              placeholder={p.path.split('/').filter(Boolean).pop() || '(root)'}
              onBlur={(e) => {
                if ((e.target.value.trim() || null) !== (p.label ?? null)) {
                  onUpdatePathLabel(p.id, e.target.value);
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              title="custom label (empty = path basename)"
            />
            <span className="dv-path-path">{p.path}</span>
            <button className="dv-path-del" onClick={() => onDeletePath(p.id)} title="delete this path">✕</button>
          </div>
        ))}
        <div className="dv-add-path">
          <span className="dv-add-glyph">+</span>
          <input
            placeholder="label (optional)"
            value={pathInput.label}
            onChange={(e) => onSetPathInput('label', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAddPath(); }}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <input
            className="dv-add-path-input"
            placeholder="/srv/foo"
            value={pathInput.path}
            onChange={(e) => onSetPathInput('path', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAddPath(); }}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <button
            className="dv-add-btn"
            onClick={onAddPath}
            disabled={!pathInput.path.trim()}
          >add</button>
        </div>
      </div>
    </section>
  );
}
