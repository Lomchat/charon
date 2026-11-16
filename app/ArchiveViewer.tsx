'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from '@/app/dynamic';
import { api } from '@/lib/api';
import type { ArchiveEntry, FsArchiveResponse } from '@/lib/types/api';
import type { ByteViewerProps } from './fileViews';
import { fromBase64, hexDump, looksLikeText, sniffMagic } from './byteText';
import { publishFsChanged } from './fsChangeBus';
import { fmtSize } from './sessionAttachments';
import ConfirmModal from './ConfirmModal';
import ImageViewer from './ImageViewer';
import { IconDownload } from './icons';

const CodeEditor = dynamic(() => import('./CodeEditor'), {
  ssr: false,
  loading: () => <div className="dvm-note">loading editor…</div>,
});

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const IMAGE_MIME: Record<string, string> = { svg: 'image/svg+xml' };

type Node = { name: string; path: string; entry?: ArchiveEntry; children: Map<string, Node> };
type Preview =
  | { kind: 'loading'; name: string }
  | { kind: 'error'; name: string; error: string }
  | { kind: 'image'; name: string; url: string; bytes: Uint8Array; truncated: boolean }
  | { kind: 'text'; name: string; text: string; bytes: Uint8Array; truncated: boolean }
  | { kind: 'binary'; name: string; dump: string; magic: string | null; bytes: Uint8Array; truncated: boolean };

function buildTree(entries: ArchiveEntry[]): Node {
  const root: Node = { name: '', path: '', children: new Map() };
  for (const e of entries) {
    const parts = e.name.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) node.children.set(part, child = { name: part, path, children: new Map() });
      if (i === parts.length - 1) child.entry = e;
      node = child;
    });
  }
  return root;
}

/**
 * Inside an archive without unpacking it (§14.112): zip (and jar/whl/epub),
 * tar (gz/bz2/xz) and a bare .gz. A folder tree with sizes and a filter; a
 * member previews as an image, as text in the read-only editor, or as hex;
 * it downloads alone; the whole archive extracts — on confirmation — into a
 * NEW folder next to it (never over one, nothing outside it, no links).
 */
export default function ArchiveViewer({ vpsId, root, path, name, rev }: ByteViewerProps) {
  const [list, setList] = useState<FsArchiveResponse | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.fsArchive(vpsId, { root, path, op: 'list' }).then((r) => {
      if (!alive) return;
      setList(r);
      // A single top folder (the usual tarball) opens itself.
      const tops = new Set((r.entries ?? []).map((e) => e.name.split('/')[0]));
      if (tops.size === 1) setOpen(new Set(tops));
      if (r.kind === 'gzip' && r.entries?.[0]) void show(r.entries[0]);
    }, (e: unknown) => { if (alive) setList({ ok: false, error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  // `show` is stable enough: it only reads props.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpsId, root, path, rev]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const tree = useMemo(() => buildTree(list?.entries ?? []), [list]);
  const q = query.trim().toLowerCase();
  const matching = useMemo(
    () => (q ? (list?.entries ?? []).filter((e) => !e.dir && e.name.toLowerCase().includes(q)) : null),
    [list, q],
  );
  const files = (list?.entries ?? []).filter((e) => !e.dir);
  const totalSize = files.reduce((n, e) => n + (e.size || 0), 0);

  const show = useCallback(async (entry: ArchiveEntry) => {
    const leaf = entry.name.split('/').filter(Boolean).pop() ?? entry.name;
    setPreview({ kind: 'loading', name: entry.name });
    try {
      const r = await api.fsArchive(vpsId, { root, path, op: 'read', member: entry.name });
      if (!r.ok || r.data == null) throw new Error(r.error ?? 'could not read this entry');
      const bytes = fromBase64(r.data);
      const truncated = !!r.truncated;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      if (IMAGE.test(leaf) && !truncated) {
        const ext = leaf.split('.').pop()!.toLowerCase();
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGE_MIME[ext] ?? `image/${ext}` }));
        urlRef.current = url;
        setPreview({ kind: 'image', name: entry.name, url, bytes, truncated });
      } else if (looksLikeText(bytes)) {
        setPreview({ kind: 'text', name: entry.name, text: new TextDecoder().decode(bytes), bytes, truncated });
      } else {
        setPreview({ kind: 'binary', name: entry.name, dump: hexDump(bytes.subarray(0, 64 * 1024)),
          magic: sniffMagic(bytes), bytes, truncated });
      }
    } catch (e: unknown) {
      setPreview({ kind: 'error', name: entry.name, error: e instanceof Error ? e.message : String(e) });
    }
  }, [vpsId, root, path]);

  const download = (p: Exclude<Preview, { kind: 'loading' | 'error' }>) => {
    const url = URL.createObjectURL(new Blob([p.bytes as BlobPart]));
    const a = document.createElement('a');
    a.href = url;
    a.download = p.name.split('/').filter(Boolean).pop() ?? 'file';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const extract = async () => {
    const r = await api.fsArchive(vpsId, { root, path, op: 'extract' });
    if (!r.ok) throw new Error(r.error ?? 'extraction failed');
    setConfirm(false);
    const skipped = r.skipped ? ` · ${r.skipped} skipped (links or unsafe names)` : '';
    setNote({ kind: 'ok', text: `extracted ${r.files} file${r.files === 1 ? '' : 's'} (${fmtSize(r.bytes ?? 0)}) into ${r.dest}/${skipped}` });
    publishFsChanged(vpsId, [`${root.replace(/\/+$/, '')}/${r.dest}`]);
  };

  if (list && !list.ok) {
    return <div className="arcv"><div className="dvm-note err">{list.error ?? 'could not read this archive'}</div></div>;
  }
  const extractName = name.replace(/\.(tar\.(gz|bz2|xz)|tgz|tbz2|txz|tar|zip|jar|whl|epub|gz)$/i, '') || `${name}.d`;
  return (
    <div className="arcv">
      <div className="viewer-bar">
        <span className="viewer-bar-note">
          {list ? `${list.kind ?? 'archive'} · ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} · ${fmtSize(totalSize)} unpacked${list.truncated ? ` · first ${list.entries?.length} of ${list.total} listed` : ''}` : 'reading…'}
        </span>
        <input className="logv-filter" type="search" placeholder="filter files" value={query}
               onChange={(e) => setQuery(e.target.value)} aria-label="Filter files" />
        <span className="viewer-bar-spacer" />
        <button type="button" disabled={!list?.ok} onClick={() => setConfirm(true)}
                title={`Extract into a new folder ${extractName}/ next to the archive`}>Extract…</button>
      </div>
      {note && <div className={`fe-note ${note.kind}`}>{note.text}</div>}
      <div className="arcv-body">
        <div className="arcv-list" role="tree">
          {matching
            ? matching.slice(0, 2000).map((e) => (
                <EntryRow key={e.name} depth={0} label={e.name} entry={e}
                          selected={preview?.name === e.name} onPick={() => void show(e)} />
              ))
            : <TreeRows node={tree} depth={0} open={open} setOpen={setOpen}
                        selected={preview?.name ?? null} onPick={(e) => void show(e)} />}
        </div>
        <div className="arcv-preview">
          {!preview && <div className="dvm-note">select a file to preview it</div>}
          {preview?.kind === 'loading' && <div className="dvm-note">reading {preview.name}…</div>}
          {preview?.kind === 'error' && <div className="dvm-note err">{preview.error}</div>}
          {preview && preview.kind !== 'loading' && preview.kind !== 'error' && (
            <>
              <div className="viewer-bar">
                <span className="viewer-bar-note">
                  {preview.name}{preview.kind === 'binary' && preview.magic ? ` · ${preview.magic}` : ''}
                  {preview.truncated ? ' · first 8 MB' : ''}
                </span>
                <span className="viewer-bar-spacer" />
                <button type="button" onClick={() => download(preview)}
                        disabled={preview.truncated} title="Download this file alone">Download</button>
              </div>
              {preview.kind === 'image' && <ImageViewer src={preview.url} name={preview.name} plate={/\.svg$/i.test(preview.name)} />}
              {preview.kind === 'text' && (
                <CodeEditor doc={preview.text} docKey={`${path}:${preview.name}`}
                            filename={preview.name.split('/').pop() ?? preview.name}
                            readOnly onChange={() => {}} onSave={() => {}} />
              )}
              {preview.kind === 'binary' && <div className="hexv-scroll"><pre className="hexv-text">{preview.dump}</pre></div>}
            </>
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmModal
          title={`Extract ${name}?`}
          confirmLabel="Extract"
          busyLabel="extracting…"
          icon={<IconDownload />}
          onConfirm={extract}
          onClose={() => setConfirm(false)}
        >
          <p>
            Everything goes into a <b>new</b> folder <code>{extractName}/</code> next to the archive.
            Nothing existing is overwritten; links and paths leading outside the folder are skipped.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

function TreeRows({ node, depth, open, setOpen, selected, onPick }: {
  node: Node; depth: number; open: Set<string>; setOpen: (f: (s: Set<string>) => Set<string>) => void;
  selected: string | null; onPick: (e: ArchiveEntry) => void;
}) {
  const kids = [...node.children.values()].sort((a, b) =>
    (a.children.size > 0 || a.entry?.dir ? 0 : 1) - (b.children.size > 0 || b.entry?.dir ? 0 : 1)
    || a.name.localeCompare(b.name));
  return (
    <>
      {kids.map((k) => {
        const isDir = k.children.size > 0 || !!k.entry?.dir;
        if (!isDir) {
          return k.entry
            ? <EntryRow key={k.path} depth={depth} label={k.name} entry={k.entry}
                        selected={selected === k.entry.name} onPick={() => onPick(k.entry!)} />
            : null;
        }
        const isOpen = open.has(k.path);
        return (
          <div key={k.path}>
            <button type="button" className="arcv-row dir" style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(k.path)) n.delete(k.path); else n.add(k.path); return n; })}>
              <span className="arcv-twisty">{isOpen ? '▾' : '▸'}</span>
              <span className="arcv-name">{k.name}/</span>
            </button>
            {isOpen && <TreeRows node={k} depth={depth + 1} open={open} setOpen={setOpen} selected={selected} onPick={onPick} />}
          </div>
        );
      })}
    </>
  );
}

function EntryRow({ depth, label, entry, selected, onPick }: {
  depth: number; label: string; entry: ArchiveEntry; selected: boolean; onPick: () => void;
}) {
  return (
    <button type="button" className={`arcv-row${selected ? ' on' : ''}`} style={{ paddingLeft: 22 + depth * 14 }}
            onClick={onPick} title={entry.link ? `link → ${entry.link}` : entry.name}>
      <span className="arcv-name">{label}{entry.link ? ' ↗' : ''}{entry.encrypted ? ' 🔒' : ''}</span>
      <span className="arcv-size">{fmtSize(entry.size)}</span>
    </button>
  );
}
