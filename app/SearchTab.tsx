'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FsSearchFile, FsSearchMode, FsSearchResponse } from '@/lib/types/api';
import { openTab as openWorkspaceTab } from './tabStore';
import { IconForKind, fileKind, IconInsert } from './fileIcons';
import { IconSearch } from './icons';
import { revealLine } from './revealLine';
import { setPathDrag } from './pathDrag';

type Props = {
  vpsId: string | null;
  cwd: string | null;
  /** Present exactly when a chat is open — same signal the explorer uses. */
  onInsertPath?: (text: string) => void;
};

type Options = {
  mode: FsSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  useDefaultExcludes: boolean;
};

const DEFAULTS: Options = {
  mode: 'text', caseSensitive: false, wholeWord: false, regex: false,
  include: '', exclude: '', useDefaultExcludes: true,
};

/**
 * What survives leaving the tab.
 *
 * The panel unmounts the moment someone looks at the diffs, and a search costs
 * a whole-repo walk over an ssh pipe — losing it on every tab switch would
 * teach people not to use the tab. Keyed on the folder, not on the session:
 * the results describe a working tree, exactly like the git cache (§14.76).
 * Module-level and deliberately not persisted — a result list goes stale the
 * moment an agent writes a file, so it must not outlive the browser tab.
 */
type Saved = { query: string; opts: Options; res: FsSearchResponse | null; showGlobs: boolean };
const memory = new Map<string, Saved>();

const OPTION_HINTS: Record<'case' | 'word' | 'regex', string> = {
  case: 'Match Case',
  word: 'Match Whole Word',
  regex: 'Use Regular Expression',
};

export default function SearchTab({ vpsId, cwd, onInsertPath }: Props) {
  const memKey = `${vpsId ?? ''} ${cwd ?? ''}`;
  const saved = memory.get(memKey);

  const [query, setQuery] = useState(saved?.query ?? '');
  const [opts, setOpts] = useState<Options>(saved?.opts ?? DEFAULTS);
  const [showGlobs, setShowGlobs] = useState(saved?.showGlobs ?? false);
  const [res, setRes] = useState<FsSearchResponse | null>(saved?.res ?? null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Latest-wins: a fast typist has three searches in flight and only the last
  // one describes what is on screen.
  const seqRef = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    memory.set(memKey, { query, opts, res, showGlobs });
  }, [memKey, query, opts, res, showGlobs]);

  // The box IS the tab, so it takes focus — except on a coarse pointer, where
  // it would raise a keyboard over the results before there are any. Same rule
  // as the VPS filter in the wizard.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const run = useCallback(async (q: string, o: Options) => {
    if (!vpsId || !cwd) return;
    if (!q) { setRes(null); setBusy(false); return; }
    const seq = ++seqRef.current;
    setBusy(true);
    try {
      const r = await api.searchFs(vpsId, {
        root: cwd, query: q, mode: o.mode,
        regex: o.regex, caseSensitive: o.caseSensitive, wholeWord: o.wholeWord,
        include: o.include, exclude: o.exclude, useDefaultExcludes: o.useDefaultExcludes,
      });
      if (seq !== seqRef.current) return;
      setRes(r);
      setCollapsed(new Set());
    } catch (e: unknown) {
      if (seq !== seqRef.current) return;
      setRes({ ok: false, files: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (seq === seqRef.current) setBusy(false);
    }
  }, [vpsId, cwd]);

  // Search as you type, like VS Code — but at 350ms and from two characters,
  // because every keystroke here is an ssh round trip and a repo walk, not a
  // local index.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { seqRef.current++; setRes(null); setBusy(false); return; }
    const t = window.setTimeout(() => { void run(query, optsRef.current); }, 350);
    return () => window.clearTimeout(t);
  }, [query, run]);

  // A toggle is an explicit decision, so it re-runs immediately instead of
  // waiting out a debounce that belongs to typing.
  const setOpt = useCallback(<K extends keyof Options>(k: K, v: Options[K]) => {
    setOpts((prev) => {
      const next = { ...prev, [k]: v };
      optsRef.current = next;
      if (query.trim().length >= 2) void run(query, next);
      return next;
    });
  }, [query, run]);

  const rerun = useCallback(() => {
    if (query.trim().length >= 2) void run(query, optsRef.current);
  }, [query, run]);
  const rerunOnEnter = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); rerun(); }
  }, [rerun]);

  const openHit = useCallback((path: string, line: number | null, pin: boolean) => {
    if (!vpsId || !cwd) return;
    if (line != null) revealLine(vpsId, cwd, path, line);
    void openWorkspaceTab({ vpsId, path: cwd, kind: 'file', ref: path, pin });
  }, [vpsId, cwd]);

  const toggleFile = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const files = res?.files ?? [];
  const summary = useMemo(() => {
    if (!res || !res.ok) return null;
    if (!files.length) return 'No results';
    const n = res.mode === 'file' ? files.length : (res.totalMatches ?? 0);
    const noun = res.mode === 'file' ? 'file' : 'result';
    return res.mode === 'file'
      ? `${n} ${noun}${n === 1 ? '' : 's'}`
      : `${n} ${noun}${n === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}`;
  }, [res, files.length]);

  if (!vpsId || !cwd) return <div className="tp-empty">no folder for this session</div>;

  return (
    <div className="search-tab">
      {/* Text or file name. The one thing this panel has that VS Code splits
          across two commands — the parameters below are the same either way,
          so hiding one behind a palette would only mean typing them twice. */}
      <div className="sr-modes" role="tablist" aria-label="what to search">
        {(['text', 'file'] as FsSearchMode[]).map((m) => (
          <button key={m} role="tab" aria-selected={opts.mode === m}
                  className={opts.mode === m ? 'on' : ''}
                  onClick={() => setOpt('mode', m)}>
            {m === 'text' ? 'in files' : 'file names'}
          </button>
        ))}
      </div>

      <div className="sr-query">
        <IconSearch className="sr-qico" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void run(query, optsRef.current); }
            if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); }
          }}
          placeholder={opts.mode === 'text' ? 'Search' : 'Search by file name'}
          spellCheck={false}
          autoComplete="off"
          aria-label="search"
        />
        <span className="sr-flags">
          <button className={opts.caseSensitive ? 'on' : ''} title={OPTION_HINTS.case}
                  aria-label={OPTION_HINTS.case} aria-pressed={opts.caseSensitive}
                  onClick={() => setOpt('caseSensitive', !opts.caseSensitive)}>Aa</button>
          {/* Whole word has no meaning against a path fragment. */}
          {opts.mode === 'text' && (
            <button className={opts.wholeWord ? 'on' : ''} title={OPTION_HINTS.word}
                    aria-label={OPTION_HINTS.word} aria-pressed={opts.wholeWord}
                    onClick={() => setOpt('wholeWord', !opts.wholeWord)}>ab</button>
          )}
          <button className={opts.regex ? 'on' : ''} title={OPTION_HINTS.regex}
                  aria-label={OPTION_HINTS.regex} aria-pressed={opts.regex}
                  onClick={() => setOpt('regex', !opts.regex)}>.*</button>
        </span>
        <button className={`sr-more ${showGlobs ? 'on' : ''}`}
                title="files to include or exclude"
                aria-label="toggle include and exclude"
                aria-expanded={showGlobs}
                onClick={() => setShowGlobs((v) => !v)}>⋯</button>
      </div>

      {showGlobs && (
        <div className="sr-globs">
          {/* Re-run on blur and on Enter, not on every keystroke: a glob is
              only meaningful once it is finished, and `src/**` passes through
              `src/*` — which matches something else entirely — on the way. */}
          <label>
            <span>files to include</span>
            <input value={opts.include} spellCheck={false} autoComplete="off"
                   placeholder="e.g. *.ts, src/**"
                   onChange={(e) => setOpts((p) => ({ ...p, include: e.target.value }))}
                   onBlur={rerun} onKeyDown={rerunOnEnter} />
          </label>
          <label>
            <span>files to exclude</span>
            <input value={opts.exclude} spellCheck={false} autoComplete="off"
                   placeholder="e.g. *.test.ts, docs/**"
                   onChange={(e) => setOpts((p) => ({ ...p, exclude: e.target.value }))}
                   onBlur={rerun} onKeyDown={rerunOnEnter} />
          </label>
          <label className="sr-check">
            <input type="checkbox" checked={opts.useDefaultExcludes}
                   onChange={(e) => setOpt('useDefaultExcludes', e.target.checked)} />
            <span>skip node_modules, build output &amp; co.</span>
          </label>
        </div>
      )}

      {busy && <div className="sr-status">searching…</div>}

      {!busy && res && !res.ok && (
        <div className={`gt-warn ${res.reason === 'bad_query' ? '' : 'err'}`}>
          {res.error || 'the search failed'}
        </div>
      )}

      {!busy && res?.ok && (
        <div className="sr-summary">
          <span>{summary}</span>
          {/* .gitignore decided the scope. Worth saying once: it explains why a
              hit in a build folder is missing far better than a support page. */}
          {res.source === 'git' && files.length > 0 && (
            <span className="sr-src" title="ignored files were left out, as git defines them">gitignore</span>
          )}
        </div>
      )}

      {!busy && res?.ok && res.truncated && (
        <div className="gt-warn">
          this is a partial answer — the search stopped at its limit, so narrow it
          with a longer term or an include pattern
        </div>
      )}

      {!busy && res?.ok && files.map((f) => (
        <FileGroup
          key={f.path}
          file={f}
          mode={res.mode ?? 'text'}
          cwd={cwd}
          collapsed={collapsed.has(f.path)}
          onToggle={() => toggleFile(f.path)}
          onOpen={openHit}
          onInsertPath={onInsertPath}
        />
      ))}

      {!busy && !res && (
        <div className="tp-empty">
          {opts.mode === 'text' ? 'search the text of every file under' : 'find a file by name under'}
          <span className="sr-root" title={cwd}>{cwd}</span>
          <span className="tp-empty-hint">two characters to start</span>
        </div>
      )}
    </div>
  );
}

function FileGroup({ file, mode, cwd, collapsed, onToggle, onOpen, onInsertPath }: {
  file: FsSearchFile;
  mode: FsSearchMode;
  cwd: string;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (path: string, line: number | null, pin: boolean) => void;
  onInsertPath?: (text: string) => void;
}) {
  const name = file.path.split('/').pop() || file.path;
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '');
  const abs = `${cwd}/${file.path}`;
  const isText = mode === 'text';

  return (
    <div className="sr-file">
      <div className="sr-fhead"
           draggable={!!onInsertPath}
           onDragStart={(e) => onInsertPath && setPathDrag(e.dataTransfer, abs)}>
        {isText && (
          <button className="sr-caret" onClick={onToggle}
                  aria-label={collapsed ? 'expand' : 'collapse'}
                  aria-expanded={!collapsed}>{collapsed ? '▸' : '▾'}</button>
        )}
        <button className="sr-fopen"
                title={abs}
                onClick={() => onOpen(file.path, isText ? (file.matches[0]?.line ?? null) : null, false)}
                onDoubleClick={() => onOpen(file.path, isText ? (file.matches[0]?.line ?? null) : null, true)}>
          <IconForKind kind={fileKind(name, false)} className="sr-fico" />
          <span className="sr-fname">{name}</span>
          {dir && <span className="sr-fdir">{dir}</span>}
        </button>
        {isText && (
          <span className="sr-fcount" title={file.truncated ? 'more matches in this file than are shown' : undefined}>
            {file.count}{file.truncated ? '+' : ''}
          </span>
        )}
        {onInsertPath && (
          <button className="sr-finsert" title="insert this path into the message"
                  aria-label="insert this path into the message"
                  onClick={() => onInsertPath(abs)}>
            <IconInsert className="sr-fico" />
          </button>
        )}
      </div>

      {isText && !collapsed && (
        <ul className="sr-hits">
          {file.matches.map((m, i) => (
            <li key={`${m.line}:${m.col}:${i}`}>
              <button className="sr-hit"
                      onClick={() => onOpen(file.path, m.line, false)}
                      onDoubleClick={() => onOpen(file.path, m.line, true)}
                      title={`line ${m.line}`}>
                <span className="sr-ln">{m.line}</span>
                <span className="sr-text">
                  {m.clipped && <span className="sr-ell">…</span>}
                  {highlight(m.text, m.ranges)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The line, with the matched spans marked.
 *
 * The offsets come from the agent, which found them, rather than from a second
 * regex here: re-running the pattern client-side means two implementations of
 * "what matched" and they disagree on exactly the cases that are hard (word
 * boundaries, a case-insensitive unicode fold).
 */
function highlight(text: string, ranges: [number, number][]) {
  if (!ranges.length) return text;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a < at || b > text.length || b <= a) return;
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}
