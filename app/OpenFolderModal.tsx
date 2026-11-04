'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import PathChooser, { knownPathsFor, type KnownPath } from './PathChooser';
import { IconFolderPlus } from './fileIcons';

/** The wizard's known paths, then the folders this VPS's sessions and shells
 *  already work in — the folders that exist for Charon on that machine. */
export function folderChoices(vps: Vps, vpsPaths: VpsPath[], inUse: string[]): KnownPath[] {
  const known = knownPathsFor(vps, vpsPaths);
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  const seen = new Set(known.map((k) => norm(k.path)));
  const extra = [...new Set(inUse.map(norm))]
    .filter((p) => p.startsWith('/') && !seen.has(p))
    .sort()
    .map((p) => ({ label: p.split('/').filter(Boolean).pop() || '/', path: p }));
  return [...known, ...extra];
}

/**
 * The explorer strip's ＋: which folder of this VPS to open as a tab. The
 * wizard's look and its path step (PathChooser): the known folders as rows,
 * the same autocomplete over the real directories. A path is checked on the
 * VPS before it becomes a tab — a typo is answered here, not by a tree that
 * cannot list.
 */
export default function OpenFolderModal({ vps, vpsPaths, inUse, onOpen, onClose }: {
  vps: Vps;
  vpsPaths: VpsPath[];
  /** Folders of this VPS's sessions and shells. */
  inUse: string[];
  /** The folder, as the VPS resolved it (`~` and `..` gone). */
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const known = useMemo(() => folderChoices(vps, vpsPaths, inUse), [vps, vpsPaths, inUse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function open(raw: string) {
    const p = raw.trim();
    if (!p) { setError('enter a path'); return; }
    if (checking) return;
    setChecking(true);
    try {
      const r = await api.listVpsDirs(vps.id, p);
      if (!r.ok) { setError(r.error || `${p} could not be read on ${vps.name}`); return; }
      if (!r.exists) { setError(`this folder does not exist on ${vps.name}`); return; }
      const resolved = r.resolved || p;
      if (!resolved.startsWith('/')) { setError('give an absolute path, starting with /'); return; }
      onOpen(resolved);
    } catch {
      setError('The folder could not be checked on the VPS.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-modal wizard open-folder" role="dialog" aria-label="open a folder">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="wiz-head">
          <span className="wiz-kind"><IconFolderPlus /> Open a folder</span>
        </div>
        <div className="wiz-body">
          <PathChooser
            vpsId={vps.id}
            label={<>Folder on <b>{vps.name}</b></>}
            known={known}
            value={value}
            onChange={(v) => { setValue(v); setError(null); }}
            onChoose={(p) => { setValue(p); void open(p); }}
            onSubmit={() => void open(value)}
            busy={checking}
            submitLabel="Open ›"
            placeholder="/etc/nginx  (type / to browse the server)"
            status={error ? `⚠ ${error}` : null}
            statusError={!!error}
            error={error}
          />
        </div>
      </div>
    </div>
  );
}
