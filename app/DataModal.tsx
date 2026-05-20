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
  // Bouton "install agent" sur une carte VPS : ferme le modal et délègue à
  // ClaudePanel qui ouvre une session install (cf. ClaudePanel.openInstallSession).
  // Avant : ouvrait un BootstrapBanner overlay DANS le modal, mais ça empilait
  // les overlays et bloquait l'accès au reste du hub pendant l'install.
  onInstallAgent?: (vps: Vps) => void;
};

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:      { glyph: '●', label: 'agent ok' },
  missing: { glyph: '○', label: 'agent non installé' },
  error:   { glyph: '◐', label: 'agent en erreur' },
  unknown: { glyph: '?', label: 'agent non testé' },
};

const DEFAULT_FOLDER_ID = 'default';

// Identifiants drag-and-drop : on encode le type pour pouvoir distinguer un
// drop sur une carte VPS (= insertion adjacente) d'un drop sur la zone d'un
// dossier (= append). On utilise prefix `folder:<id>` et `vps:<id>`.
//   - Les VPS sont sortables intra-dossier ET draggables vers un autre dossier.
//   - Les dossiers (le bloc entier) sont sortables entre eux.
// La zone "drop dans le dossier" (= droppable id `folder-drop:<id>`) capture
// les VPS qu'on lâche sur l'espace du dossier (pas sur une carte précise).
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
  // État du formulaire d'ajout de path par VPS (inline)
  const [pathInputs, setPathInputs] = useState<Record<string, { path: string; label: string }>>({});
  // ID drag-and-drop en cours (pour DragOverlay)
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Handler pour le bouton "install" : ferme le modal et délègue. Si pas de
  // callback fourni (cas legacy ou test), no-op silencieux.
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

  // ─── Folders triés & VPS groupés ─────────────────────────
  // Règle "default last" : le dossier 'default' (Sans dossier) est toujours
  // tout en bas, peu importe sa `position` stockée. Le reste est trié par
  // position croissante. Cette règle est appliquée côté UI mais aussi
  // maintenue côté API (createVpsFolder pousse default à max+1 après
  // chaque insertion).
  const sortedFolders = useMemo(() => {
    return [...folders].sort((a, b) => {
      if (a.id === DEFAULT_FOLDER_ID) return 1;
      if (b.id === DEFAULT_FOLDER_ID) return -1;
      return a.position - b.position;
    });
  }, [folders]);
  // Folders draggables (= tous sauf 'default')
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
      setErr('nom, ip et user requis');
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
    if (!confirm(`Supprimer ${name} ?\nSes paths et sessions seront aussi supprimés.`)) return;
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
    if (!name) { setErr('nom requis'); return; }
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
    if (id === DEFAULT_FOLDER_ID) { setErr('le dossier par défaut ne peut pas être supprimé'); return; }
    const inside = vpsByFolder.get(id) ?? [];
    const msg = inside.length > 0
      ? `Supprimer le dossier "${name}" ?\nSes ${inside.length} VPS seront déplacés dans "Sans dossier".`
      : `Supprimer le dossier "${name}" ?`;
    if (!confirm(msg)) return;
    try {
      await api.deleteVpsFolder(id);
      const nextFolders = folders.filter((f) => f.id !== id);
      // Côté local : déplace les VPS vers default folder (positions à la fin)
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
    if (!form.path.trim()) { setErr('path requis'); return; }
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

  // ─── Déplacement d'un VPS vers un autre dossier (via select) ─────────
  // Appelé par le `<select>` dans chaque carte VPS. La logique est la même
  // que celle du drag-end "drop sur folder body" : on retire le VPS de son
  // dossier actuel et on l'append à la fin du nouveau dossier. Optimiste
  // côté state, suivi d'un POST atomique.
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
    // VPS dans des folders inconnus (orphelins) : on les laisse tels quels.
    const known = new Set(sortedFolders.map((f) => f.id));
    for (const v of vpsList) {
      if (!known.has(v.folderId) && v.id !== vpsId) flat.push(v);
    }
    setVpsList(flat);
    persistLayout(sortedFolders, flat);
  }, [vpsList, sortedFolders, vpsByFolder]); // eslint-disable-line

  // ─── Persistance d'un re-layout (drag-end) ───────────
  // Construit l'état complet (positions de tous les folders + folderId/position
  // de tous les VPS) à partir du state React local, puis l'envoie en POST.
  const persistLayout = useCallback(async (
    nextFolders: VpsFolder[],
    nextVps: Vps[],
  ) => {
    try {
      const res = await api.applyVpsLayout({
        folders: nextFolders.map((f, idx) => ({ id: f.id, position: idx })),
        vps: nextVps.map((v) => ({ id: v.id, folderId: v.folderId, position: v.position })),
      });
      // Resync depuis le serveur (au cas où un VPS ait été créé entre-temps).
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
      // Évite que le simple clic sur un bouton dans une carte VPS déclenche
      // un drag accidentel — il faut un drag de 6px pour activer.
      activationConstraint: { distance: 6 },
    }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function handleDragOver(_e: DragOverEvent) {
    // No-op : on calcule tout au drag-end (pas de cross-container live preview
    // — coûteux à animer pour un gain UX marginal sur cette liste).
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over) return;
    const a = decodeId(String(active.id));
    const o = decodeId(String(over.id));
    if (active.id === over.id) return;

    // 1) Réordonnement de folders. Seuls les folders draggables (= non-default)
    //    participent. 'default' reste toujours en dernier (rendu en dehors du
    //    SortableContext, donc impossible de drop dessus pour le folder-drag).
    if (a.kind === 'folder' && o.kind === 'folder') {
      if (a.id === DEFAULT_FOLDER_ID || o.id === DEFAULT_FOLDER_ID) return;
      const oldIdx = draggableFolders.findIndex((f) => f.id === a.id);
      const newIdx = draggableFolders.findIndex((f) => f.id === o.id);
      if (oldIdx < 0 || newIdx < 0) return;
      const reordered = arrayMove(draggableFolders, oldIdx, newIdx).map((f, i) => ({ ...f, position: i }));
      // Reconstruit le state folders : non-default réordonnés + default en bout.
      const next = defaultFolder
        ? [...reordered, { ...defaultFolder, position: reordered.length }]
        : reordered;
      setFolders(next);
      persistLayout(next, vpsList);
      return;
    }

    // 2) Réordonnement / déplacement de VPS
    if (a.kind === 'vps') {
      const movedVps = vpsList.find((v) => v.id === a.id);
      if (!movedVps) return;

      // Cible : soit une autre carte VPS, soit la zone d'un dossier
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
        targetIndex = inFolder.length; // append à la fin
      } else {
        return;
      }

      // Reconstruit toutes les positions intra-folder en partant des groupes
      // actuels, en retirant le VPS déplacé puis en l'insérant à targetIndex
      // dans le folder cible.
      const groups = new Map<string, Vps[]>();
      for (const f of sortedFolders) groups.set(f.id, [...(vpsByFolder.get(f.id) ?? []).filter((v) => v.id !== a.id)]);
      // Au cas où le folder n'existe pas dans `groups` (data drift), fallback
      if (!groups.has(targetFolderId)) groups.set(targetFolderId, []);
      const tgt = groups.get(targetFolderId)!;
      const moved = { ...movedVps, folderId: targetFolderId };
      tgt.splice(Math.min(targetIndex, tgt.length), 0, moved);

      // Aplatit en une nouvelle liste avec positions normalisées
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
            >{addFolderOpen ? '− annuler' : '+ dossier'}</button>
            <button
              className="data-add-vps-btn"
              onClick={() => { setAddVpsOpen(!addVpsOpen); setAddFolderOpen(false); }}
            >{addVpsOpen ? '− annuler' : '+ VPS'}</button>
          </div>
        </header>
        <p className="data-help">
          Glisse les dossiers pour les réordonner, ou un VPS pour le déplacer dans un autre dossier (ou changer son ordre).
        </p>

        {err && <div className="data-err">{err}</div>}

        {addFolderOpen && (
          <div className="data-add data-add-folder">
            <input
              placeholder="nom du dossier"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addFolder(); else if (e.key === 'Escape') setAddFolderOpen(false); }}
              autoFocus
            />
            <button className="primary" onClick={addFolder} disabled={!newFolderName.trim()}>créer</button>
          </div>
        )}

        {addVpsOpen && (
          <div className="data-add data-add-vps">
            <input placeholder="nom" value={vpsForm.name} onChange={(e) => setVpsForm({ ...vpsForm, name: e.target.value })} autoFocus />
            <input placeholder="ip ou hostname" value={vpsForm.ip} onChange={(e) => setVpsForm({ ...vpsForm, ip: e.target.value })} />
            <input placeholder="ssh user" value={vpsForm.sshUser} onChange={(e) => setVpsForm({ ...vpsForm, sshUser: e.target.value })} style={{ maxWidth: 100 }} />
            <input placeholder="port" value={vpsForm.sshPort} onChange={(e) => setVpsForm({ ...vpsForm, sshPort: e.target.value })} style={{ maxWidth: 60 }} inputMode="numeric" />
            <input placeholder="default path (opt.)" value={vpsForm.defaultPath} onChange={(e) => setVpsForm({ ...vpsForm, defaultPath: e.target.value })} />
            <select
              value={vpsForm.folderId}
              onChange={(e) => setVpsForm({ ...vpsForm, folderId: e.target.value })}
              title="dossier d'accueil"
            >
              {sortedFolders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <button className="primary" onClick={addVps}>créer</button>
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
              <div className="data-empty">aucun dossier — clique sur « + dossier » pour commencer</div>
            )}
            {/* Folders draggables : réordonnables entre eux via DnD */}
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
            {/* Dossier 'default' : rendu en dehors du SortableContext donc
                non-draggable comme folder. Mais sa zone (droppable) accepte
                quand même les VPS qu'on glisse dedans, et son contenu de
                VPS reste sortable intra-folder. */}
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
        <span className="data-folder-drag-handle" {...listeners} title="glisser pour réordonner les dossiers">⋮⋮</span>
        <span className="data-folder-glyph">▤</span>
        <FolderRenameInput initial={folder.name} onSubmit={onRename} />
        <span className="data-folder-count">{vps.length} VPS</span>
        {folder.id !== DEFAULT_FOLDER_ID && (
          <button className="dv-btn danger" onClick={onDelete} title="supprimer ce dossier">✕</button>
        )}
      </header>
      <div ref={setDroppableNodeRef} className="data-folder-body">
        <SortableContext
          items={vps.map((v) => vpsDragId(v.id))}
          strategy={verticalListSortingStrategy}
        >
          {vps.length === 0 && (
            <div className="data-folder-empty">vide — glisse un VPS ici</div>
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

// Hook utilitaire : combine useSortable (pour réordonner les folders entre eux)
// avec un useDroppable séparé sur le body du dossier (pour accepter les VPS
// qui tombent sur l'espace vide du dossier). Les deux refs sont appliquées à
// des nœuds DOM différents (section pour le sortable, body pour le droppable).
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
// StaticFolder : variante non-draggable de SortableFolder, utilisée pour le
// dossier 'default' qui est verrouillé en dernière position. Pas de drag
// handle, pas de bouton supprimer. Le body reste droppable pour qu'on
// puisse y déposer des VPS, et le SortableContext interne permet de
// réordonner les VPS qui y vivent.
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
  // Le body est droppable pour qu'on puisse y déposer des VPS au drag-end.
  const { setNodeRef: setBodyRef } = useDroppable({ id: folderDropZoneId(folder.id) });
  return (
    <section className="data-folder-card data-folder-static">
      <header className="data-folder-head">
        {/* Pas de drag handle ici : ce dossier est verrouillé en dernier */}
        <span className="data-folder-lock" title="dossier verrouillé en dernière position">🔒</span>
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
            <div className="data-folder-empty">vide — glisse un VPS ici ou utilise le select à côté d'un VPS</div>
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
// SortableVpsCard : une carte VPS draggable. Le drag est déclenché par le
// handle (⋮⋮) pour que les inputs/boutons restent cliquables sans risque
// de mauvaise interprétation.
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
        <span className="data-vps-drag-handle" {...listeners} title="glisser pour réordonner ou déplacer dans un autre dossier">⋮⋮</span>
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
          title="changer de dossier"
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
          <button className="dv-btn danger" onClick={onDelete} title="supprimer ce VPS">✕</button>
        </div>
      </header>
      <div className="data-vps-paths">
        {vpsPathsRows.length === 0 && (
          <div className="dv-empty">aucun path enregistré pour ce VPS</div>
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
              title="label personnalisé (vide = basename du path)"
            />
            <span className="dv-path-path">{p.path}</span>
            <button className="dv-path-del" onClick={() => onDeletePath(p.id)} title="supprimer ce path">✕</button>
          </div>
        ))}
        <div className="dv-add-path">
          <span className="dv-add-glyph">+</span>
          <input
            placeholder="label (optionnel)"
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
          >ajouter</button>
        </div>
      </div>
    </section>
  );
}
