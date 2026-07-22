'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import ModelPicker from './ModelPicker';
import EffortPicker from './EffortPicker';
import CodexModelPicker from './CodexModelPicker';
import CodexEffortPicker from './CodexEffortPicker';
import AgentLogo from './AgentLogo';
import { IconTerminal } from './icons';
import type { AgentKind, CodexSandboxMode } from '@/lib/types/api';
import { CODEX_SANDBOX_MODES } from '@/lib/types/api';
import { agentAvailability, backendAvailability, type VpsFix, type VpsFixAction } from './vpsHealth';

// 3-step "new session" wizard (prod). `kind` (agent vs shell) is fixed by the
// button that opened it. For agents, the BACKEND (Claude vs Codex) is either
// fixed (`agentKind` prop, from a per-VPS Claude/Codex button) or chosen in
// step 1 (the global "＋ Agent" button → VPS+backend picker).
//   1. pick a VPS (grouped by folder; for a backend-unfixed agent, each VPS
//      row exposes two buttons Claude/Codex; skipped when a VPS is passed in)
//   2. pick a path  (known paths + a custom one; "home" for shells)
//   3. name it (+ optional model/effort/mode for agents) and launch
type Step = 'vps' | 'path' | 'name';
const DEFAULT_FOLDER_ID = 'default';

const CODEX_MODE_DESC: Record<CodexSandboxMode, string> = {
  'read-only': 'can read files & run read-only commands; no writes',
  'workspace-write': 'can edit files in the workspace; network off by default',
  'full-access': 'no sandbox — full file & network access (danger)',
};

type Props = {
  kind: 'agent' | 'shell';
  // Backend for agent launches. When provided the wizard skips the
  // Claude/Codex picker (per-VPS ＋ button); when absent + kind==='agent' the
  // user chooses per VPS in step 1.
  agentKind?: AgentKind;
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialVpsId?: string;
  initialCwd?: string | null;
  onClose: () => void;
  onCreatedSession?: (id: string) => void;
  onCreatedShell?: (shell: ShellInfo) => void;
  // Repair button on an unavailable VPS row (cf. app/vpsHealth.tsx). The
  // parent decides what closes the wizard (install / claude-login do; a
  // refresh or update runs in place — the row repaints via the live vpsList
  // prop + the busy sets below).
  onFix?: (v: Vps, action: VpsFixAction) => void;
  refreshingAgentVpsIds?: Set<string>;
  updatingAgentVpsIds?: Set<string>;
};

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || '(root)';
}

export default function NewSessionWizard({
  kind, agentKind, vpsList, vpsFolders, vpsPaths, initialVpsId, initialCwd, onClose,
  onCreatedSession, onCreatedShell,
  onFix, refreshingAgentVpsIds, updatingAgentVpsIds,
}: Props) {
  const hasInitialCwd = typeof initialCwd === 'string' && initialCwd.trim() !== '';
  // Backend is fixed either by the caller (agentKind) or trivially for shells.
  // When agent + unfixed, the user picks it in the VPS step.
  const backendFixed = kind !== 'agent' || agentKind != null;
  const [selKind, setSelKind] = useState<AgentKind>(agentKind ?? 'claude');
  const [vpsId, setVpsId] = useState<string | null>(initialVpsId ?? null);
  const [path, setPath] = useState<string | null>(hasInitialCwd ? initialCwd! : null);
  const [pathChosen, setPathChosen] = useState<boolean>(hasInitialCwd);
  const [name, setName] = useState('');
  const [custom, setCustom] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  // ── Path autocomplete (step 2) ── suggestions = known paths ∪ the REAL
  // subdirectories of the typed dir on the VPS (GET /api/vps/[id]/fs,
  // debounced, cached per dir for the wizard's lifetime).
  type Suggestion = { path: string; kind: 'known' | 'dir' };
  const [sug, setSug] = useState<Suggestion[]>([]);
  const [sugOpen, setSugOpen] = useState(false);
  const [sugIdx, setSugIdx] = useState(-1);
  const [sugLoading, setSugLoading] = useState(false); // ssh listing in flight (or debounce-pending)
  const [sugNote, setSugNote] = useState<string | null>(null); // "no match" / failure hint
  const [checking, setChecking] = useState(false);      // existence check on "Use ›"
  const [allowForce, setAllowForce] = useState(false);  // "use anyway" after a failed check
  const customRef = useRef<HTMLInputElement | null>(null);
  const sugListRef = useRef<HTMLDivElement | null>(null);
  const dirCacheRef = useRef(new Map<string, string[]>());  // `${vpsId}:${dir}` → subdirs
  const prefetchingRef = useRef(new Set<string>());
  const fetchSeqRef = useRef(0);
  const [step, setStep] = useState<Step>(initialVpsId ? (hasInitialCwd ? 'name' : 'path') : 'vps');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isCodex = kind === 'agent' && selKind === 'codex';

  // Optional per-session config (agent only). Blank = inherit the global
  // default (claude.default_* / codex.default_*). Codex has no fallback model
  // and its "mode" is a sandbox level (default workspace-write).
  const [showAdv, setShowAdv] = useState(false);
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState('');
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>('workspace-write');
  const [globalDefaults, setGlobalDefaults] = useState<{ model: string; fallbackModel: string; effort: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (kind !== 'agent') return;
    api.getClaudeSettings()
      .then((s) => setGlobalDefaults({
        model: s['claude.default_model'] ?? '',
        fallbackModel: s['claude.default_fallback_model'] ?? '',
        effort: s['claude.default_effort'] ?? '',
      }))
      .catch(() => {});
  }, [kind]);

  // Reset per-backend config when the backend switches (model ids / efforts
  // aren't comparable across Claude and Codex).
  useEffect(() => { setModel(''); setFallbackModel(''); setEffort(''); }, [selKind]);

  const vps = vpsId ? vpsList.find((v) => v.id === vpsId) ?? null : null;
  const agentLabel = selKind === 'codex' ? 'Codex agent' : 'Claude agent';
  const kindLabel = kind === 'agent' ? agentLabel : 'SSH shell';
  const KindIcon = kind === 'agent'
    ? () => <AgentLogo kind={selKind} size={15} />
    : () => <IconTerminal />;

  // VPSes grouped by folder ("default" folder last), only non-empty folders.
  const buckets = useMemo(() => {
    const sortedFolders = [...vpsFolders].sort((a, b) => {
      if (a.id === DEFAULT_FOLDER_ID) return 1;
      if (b.id === DEFAULT_FOLDER_ID) return -1;
      return a.position - b.position;
    });
    const byFolder = new Map<string, Vps[]>();
    for (const v of vpsList) {
      const arr = byFolder.get(v.folderId) ?? [];
      arr.push(v);
      byFolder.set(v.folderId, arr);
    }
    for (const arr of byFolder.values()) arr.sort((a, b) => a.position - b.position);
    const known = new Set(sortedFolders.map((f) => f.id));
    const out = sortedFolders
      .map((folder) => ({ folder, vps: byFolder.get(folder.id) ?? [] }))
      .filter((b) => b.vps.length > 0);
    const orphans = vpsList.filter((v) => !known.has(v.folderId));
    if (orphans.length > 0) out.push({ folder: { id: '__o', name: '(other)' } as VpsFolder, vps: orphans });
    return out;
  }, [vpsList, vpsFolders]);

  const pickList = useMemo(() => {
    if (!vps) return [] as { label: string; path: string }[];
    const rows = vpsPaths
      .filter((p) => p.vpsId === vps.id)
      .map((p) => ({ label: p.label || basename(p.path), path: p.path }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const dp = (vps as any).defaultPath as string | null | undefined;
    if (dp && !rows.some((r) => r.path === dp)) rows.unshift({ label: 'default', path: dp });
    return rows;
  }, [vps, vpsPaths]);

  // Per-VPS availability — shared diagnosis (app/vpsHealth.tsx). Sessions
  // need the whole stack for their backend; a shell only needs the agent
  // layer (ssh + daemon). Each row shows the precise blocker + its fix.
  const availFor = (v: Vps, k: AgentKind) => backendAvailability(v, k);

  // The blockers to paint under a row, each PAIRED with its own repair
  // button ("⚠ reason [fix]" per line — never a detached button cluster).
  // Agent-layer problems (ssh / no agent / daemon down) are common to both
  // backends → ONE pair; otherwise one pair per broken backend.
  function rowIssues(v: Vps): { text: string; fix?: VpsFix }[] {
    const agent = agentAvailability(v);
    if (!agent.ok) return [{ text: agent.reason, fix: agent.fix }];
    if (kind !== 'agent') return [];
    const out: { text: string; fix?: VpsFix }[] = [];
    const kinds: AgentKind[] = backendFixed ? [selKind] : ['claude', 'codex'];
    for (const k of kinds) {
      const av = backendAvailability(v, k);
      if (av.ok) continue;
      out.push({
        text: backendFixed ? av.reason : `${k === 'codex' ? 'Codex' : 'Claude'}: ${av.reason}`,
        fix: av.fix,
      });
    }
    return out;
  }
  const fixBusy = (v: Vps, action: VpsFixAction) =>
    (action === 'refresh' && !!refreshingAgentVpsIds?.has(v.id)) ||
    (action === 'update' && !!updatingAgentVpsIds?.has(v.id));

  function pickVps(v: Vps, k?: AgentKind) {
    const backend = k ?? selKind;
    if (kind === 'agent') {
      if (!availFor(v, backend).ok) return;
      setSelKind(backend);
    } else if (!agentAvailability(v).ok) {
      return; // a shell still needs the agent up
    }
    setVpsId(v.id);
    setPath(null); setPathChosen(false);
    setStep('path');
  }
  function choosePath(p: string | null) {
    setPath(p); setPathChosen(true); setPathError(null);
    setSugOpen(false);
    setStep('name');
  }

  // Live path suggestions. No '/' typed yet → known paths only (fuzzy).
  // Otherwise split on the LAST '/': list the dir on the VPS (debounced
  // 250ms; per-dir cache makes further keystrokes in the same dir instant)
  // and prefix-filter its subdirs, with matching known paths on top.
  useEffect(() => {
    if (step !== 'path' || !vpsId) return;
    const typed = custom;
    const seq = ++fetchSeqRef.current;
    const q = typed.trim().toLowerCase();
    const knownMatches: Suggestion[] = pickList
      .filter((p) => p.path !== typed && (q === '' || p.path.toLowerCase().includes(q)))
      .map((p) => ({ path: p.path, kind: 'known' as const }));
    const lastSlash = typed.lastIndexOf('/');
    if (lastSlash === -1) { setSug(knownMatches.slice(0, 12)); setSugIdx(-1); setSugLoading(false); setSugNote(null); return; }
    const dir = typed.slice(0, lastSlash + 1) || '/';
    const base = typed.slice(lastSlash + 1);
    const compose = (subdirs: string[], failed = false) => {
      const dirMatches: Suggestion[] = subdirs
        .filter((n) => n.startsWith(base))
        .slice(0, 30)
        .map((n) => ({ path: dir + n + '/', kind: 'dir' as const }));
      const seen = new Set(dirMatches.map((s) => s.path));
      const merged = [
        ...knownMatches.filter((k) => !seen.has(k.path) && !seen.has(k.path + '/')).slice(0, 6),
        ...dirMatches,
      ];
      setSug(merged);
      setSugIdx(-1);
      setSugLoading(false);
      setSugNote(merged.length === 0 ? (failed ? 'listing failed' : 'no matching directory') : null);
    };
    const cacheKey = `${vpsId}:${dir}`;
    const cached = dirCacheRef.current.get(cacheKey);
    if (cached) { compose(cached); return; }
    // Uncached dir → the spinner shows through the debounce AND the ssh
    // round-trip (the user must SEE that deeper levels are on their way).
    setSugLoading(true); setSugNote(null);
    const t = setTimeout(() => {
      api.listVpsDirs(vpsId, dir)
        .then((r) => {
          if (seq !== fetchSeqRef.current) return;   // stale response
          const subdirs = r.ok && r.exists ? (r.dirs ?? []) : [];
          if (r.ok) dirCacheRef.current.set(cacheKey, subdirs); // never cache a FAILURE
          compose(subdirs, !r.ok);
        })
        .catch(() => { if (seq === fetchSeqRef.current) compose([], true); });
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom, step, vpsId, pickList]);

  // Warm-up: entering step 2 pre-lists '/' in the background. This opens the
  // per-VPS persistent SSH master server-side (the expensive part) so the
  // first real keystroke listing returns fast, and pre-caches the root dir.
  useEffect(() => {
    if (step !== 'path' || !vpsId) return;
    const key = `${vpsId}:/`;
    if (dirCacheRef.current.has(key)) return;
    api.listVpsDirs(vpsId, '/')
      .then((r) => { if (r.ok) dirCacheRef.current.set(key, r.dirs ?? []); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, vpsId]);

  // Pre-list a suggested dir while the user hovers/highlights it — by the
  // time they click, the drill-down composes straight from cache.
  function prefetchDir(p: string) {
    if (!vpsId) return;
    const key = `${vpsId}:${p}`;
    if (dirCacheRef.current.has(key) || prefetchingRef.current.has(key)) return;
    prefetchingRef.current.add(key);
    api.listVpsDirs(vpsId, p)
      .then((r) => { if (r.ok) dirCacheRef.current.set(key, r.dirs ?? []); })
      .catch(() => {})
      .finally(() => prefetchingRef.current.delete(key));
  }

  // Keep the highlighted suggestion visible while arrowing through the list
  // (+ prefetch it so Enter drills down instantly).
  useEffect(() => {
    if (sugIdx < 0) return;
    sugListRef.current?.children[sugIdx]?.scrollIntoView({ block: 'nearest' });
    const s = sug[sugIdx];
    if (s?.kind === 'dir') prefetchDir(s.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugIdx]);

  // The ⧉ button on a known-path row: put the path in the input AS-IS —
  // no validation, no step change — so it can be edited / drilled into.
  function copyToInput(p: string) {
    setCustom(p);
    setPathError(null); setAllowForce(false);
    setSugOpen(true);
    requestAnimationFrame(() => customRef.current?.focus());
  }

  function applySuggestion(s: Suggestion) {
    setCustom(s.path);
    setPathError(null); setAllowForce(false);
    setSugOpen(true);
    customRef.current?.focus();
  }

  function onCustomKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && sugOpen) {
      // Close only the dropdown — NOT the wizard (the modal's window-level
      // Escape listener sits behind this stopPropagation).
      e.stopPropagation(); setSugOpen(false); return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sug.length > 0) {
      e.preventDefault();
      setSugOpen(true);
      setSugIdx((i) => {
        const n = sug.length;
        return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === 'Tab' && sugOpen && sug.length > 0) {
      e.preventDefault();
      applySuggestion(sug[Math.max(0, sugIdx)]);
      return;
    }
    if (e.key === 'Enter') {
      if (sugOpen && sugIdx >= 0 && sug[sugIdx]) { applySuggestion(sug[sugIdx]); return; }
      void submitCustom();
    }
  }

  // "Use ›" — checks the dir actually EXISTS on the VPS first (same fs
  // listing = "can we cd there"), and canonicalizes (~ / .. / trailing
  // slash) via the returned `pwd`. Soft: an ssh-level failure falls through
  // and accepts the path as typed; `force` = the "use anyway" escape hatch.
  async function submitCustom(force = false) {
    const p = custom.trim();
    if (!p) { setPathError('enter a path'); return; }
    if (!vps || force || checking) { if (!checking) choosePath(p); return; }
    setChecking(true);
    try {
      const r = await api.listVpsDirs(vps.id, p);
      if (r.ok && r.exists === false) {
        setPathError(`this directory does not exist on ${vps.name}`);
        setAllowForce(true);
        return;
      }
      if (r.ok && r.exists && r.resolved) { choosePath(r.resolved); return; }
    } catch {
      // ssh hiccup — don't block the flow
    } finally {
      setChecking(false);
    }
    choosePath(p);
  }

  async function launch() {
    if (!vps || busy) return;
    if (kind === 'agent' && (path == null || !path.trim())) { setStep('path'); setPathError('a path is required'); return; }
    setBusy(true); setErr(null);
    try {
      if (kind === 'agent') {
        const r = await api.createClaudeSession({
          vpsId: vps.id, cwd: path!.trim(),
          name: name.trim() || null,
          kind: selKind,
          // Codex mode = a sandbox level; Claude keeps the historical 'auto'.
          permissionMode: isCodex ? codexSandbox : 'auto',
          model: model.trim() || null,
          // Codex has no fallback-model concept (server ignores it anyway).
          fallbackModel: isCodex ? null : (fallbackModel.trim() || null),
          effort: effort || null,
        });
        onCreatedSession?.(r.id);
      } else {
        const shell = await api.startShell(vps.id, {
          cwd: path ? path.trim() : null,   // null = user home
          name: name.trim() || null,
        });
        onCreatedShell?.(shell);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  }

  const pathLabel = pathChosen ? (path == null ? '~ (home)' : path) : 'Path';

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`claude-modal wizard kind-${kind}`}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="wiz-head">
          <span className="wiz-kind"><KindIcon /> New {kindLabel}</span>
        </div>

        <div className="wiz-crumbs">
          <Crumb n={1} label={vps ? vps.name : 'VPS'} active={step === 'vps'}
            done={!!vps && step !== 'vps'} onClick={() => setStep('vps')} />
          <span className="wiz-crumb-sep">▸</span>
          <Crumb n={2} label={pathLabel} active={step === 'path'}
            done={pathChosen && step !== 'path'} disabled={!vps}
            onClick={() => vps && setStep('path')} />
          <span className="wiz-crumb-sep">▸</span>
          <Crumb n={3} label="Name" active={step === 'name'} done={false}
            disabled={!pathChosen} onClick={() => pathChosen && setStep('name')} />
        </div>

        {/* ── Step 1: VPS (+ backend, when the agent backend isn't fixed) ── */}
        {step === 'vps' && (
          <div className="wiz-body">
            <div className="wiz-label">
              {kind === 'agent' && !backendFixed ? 'Choose a VPS & backend' : 'Choose a VPS'}
            </div>
            {buckets.length === 0 && <div className="wiz-error">no VPS — add one in « manage VPS »</div>}
            {buckets.map(({ folder, vps: list }) => (
              <div key={folder.id} className="wiz-folder">
                <div className="wiz-folder-name">▤ {folder.name}</div>
                <div className="wiz-pick-list">
                  {list.map((v) => {
                    const status = (v as any).agentStatus ?? 'unknown';
                    const issues = rowIssues(v);
                    // One "⚠ reason [fix]" line PER problem (the reasons come
                    // from the shared diagnosis — "VPS unreachable (SSH)" vs
                    // "agent not installed" vs "Claude: not signed in"…),
                    // each with its own repair button right after it.
                    const issuesEl = issues.length === 0 ? null : (
                      <span className="wiz-pick-issues">
                        {issues.map((it, i) => (
                          <span key={i} className="wiz-issue">
                            <span className="wiz-issue-text">⚠ {it.text}</span>
                            {onFix && it.fix && (
                              <button type="button" className="wiz-fix-btn"
                                disabled={fixBusy(v, it.fix.action)} title={it.fix.title}
                                onClick={(e) => { e.stopPropagation(); onFix(v, it.fix!.action); }}
                              >{fixBusy(v, it.fix.action) ? '⟳ …' : it.fix.label}</button>
                            )}
                          </span>
                        ))}
                      </span>
                    );
                    // Agent + unfixed backend: two buttons (Claude / Codex),
                    // each greyed by its own availability with an explanatory tip.
                    if (kind === 'agent' && !backendFixed) {
                      const cl = availFor(v, 'claude');
                      const cx = availFor(v, 'codex');
                      return (
                        <div key={v.id} className="wiz-pick static">
                          <span className={`wiz-pick-dot agent-${status}`} />
                          <span className="wiz-pick-main">
                            <span className="wiz-pick-name">{v.name}</span>
                            <span className="wiz-pick-sub">{v.sshUser}@{v.ip}</span>
                            {issuesEl}
                          </span>
                          <span className="wiz-kind-btns">
                            <button type="button" className="wiz-kind-btn"
                              disabled={!cl.ok} title={cl.reason}
                              onClick={() => pickVps(v, 'claude')}>
                              <AgentLogo kind="claude" size={15} /><span>Claude</span>
                            </button>
                            <button type="button" className="wiz-kind-btn"
                              disabled={!cx.ok} title={cx.reason}
                              onClick={() => pickVps(v, 'codex')}>
                              <AgentLogo kind="codex" size={15} /><span>Codex</span>
                            </button>
                          </span>
                        </div>
                      );
                    }
                    // Shell OR fixed-backend agent: single clickable row. A
                    // shell needs the agent layer too (shell_start is an agent
                    // RPC) — same gating, minus the login/backend checks.
                    const disabled = kind === 'agent' ? !availFor(v, selKind).ok : !agentAvailability(v).ok;
                    if (disabled) {
                      // Not a <button>: the row hosts the repair buttons
                      // (nested <button> is invalid HTML) and isn't clickable.
                      return (
                        <div key={v.id} className="wiz-pick static disabled">
                          <span className={`wiz-pick-dot agent-${status}`} />
                          <span className="wiz-pick-main">
                            <span className="wiz-pick-name">{v.name}</span>
                            <span className="wiz-pick-sub">{v.sshUser}@{v.ip}</span>
                            {issuesEl}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <button key={v.id}
                        className="wiz-pick"
                        onClick={() => pickVps(v)}
                      >
                        <span className={`wiz-pick-dot agent-${status}`} />
                        <span className="wiz-pick-main">
                          <span className="wiz-pick-name">{v.name}</span>
                          <span className="wiz-pick-sub">{v.sshUser}@{v.ip}</span>
                        </span>
                        <span className="wiz-pick-go">›</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Step 2: Path ── */}
        {step === 'path' && vps && (
          <div className="wiz-body">
            <div className="wiz-label">Path on <b>{vps.name}</b></div>
            <div className="wiz-pick-list">
              {kind === 'shell' && (
                <button className="wiz-pick" onClick={() => choosePath(null)}>
                  <span className="wiz-pick-glyph">~</span>
                  <span className="wiz-pick-main">
                    <span className="wiz-pick-name">home</span>
                    <span className="wiz-pick-sub">the SSH user's home directory</span>
                  </span>
                  <span className="wiz-pick-go">›</span>
                </button>
              )}
              {pickList.map((p) => (
                // A <div>, not a <button>: the row hosts the nested ⧉
                // copy-to-input button (nested <button> is invalid HTML).
                <div key={p.path} className="wiz-pick" role="button" tabIndex={0}
                  onClick={() => choosePath(p.path)}
                  onKeyDown={(e) => { if (e.key === 'Enter') choosePath(p.path); }}
                >
                  <span className="wiz-pick-glyph">▤</span>
                  <span className="wiz-pick-main">
                    <span className="wiz-pick-name">{p.label}</span>
                    <span className="wiz-pick-sub mono">{p.path}</span>
                  </span>
                  <button type="button" className="wiz-pick-copy"
                    title="copy this path into the input (edit before use)"
                    onClick={(e) => { e.stopPropagation(); copyToInput(p.path); }}
                  >⧉</button>
                  <span className="wiz-pick-go">›</span>
                </div>
              ))}
            </div>
            <div className="wiz-custom">
              <input
                ref={customRef}
                placeholder="/custom/path…  (type / to browse the server)"
                value={custom}
                onChange={(e) => { setCustom(e.target.value); setPathError(null); setAllowForce(false); setSugOpen(true); }}
                onFocus={() => setSugOpen(true)}
                onBlur={() => setTimeout(() => setSugOpen(false), 120)}
                onKeyDown={onCustomKeyDown}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
              <button className="wiz-btn primary" onClick={() => void submitCustom()} disabled={checking}>
                {checking ? '…' : 'Use ›'}
              </button>
            </div>
            {sugOpen && (sug.length > 0 || sugLoading || sugNote) && (
              <div className="wiz-sug" ref={sugListRef}>
                {sug.map((s2, i) => (
                  // onMouseDown preventDefault keeps the input focused so the
                  // blur-close doesn't swallow the click.
                  <button key={s2.kind + s2.path} type="button"
                    className={`wiz-sug-item${i === sugIdx ? ' active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => { if (s2.kind === 'dir') prefetchDir(s2.path); }}
                    onClick={() => applySuggestion(s2)}
                  >
                    <span className="wiz-sug-tag">{s2.kind === 'known' ? '★' : '▸'}</span>
                    <span className="wiz-sug-path">{s2.path}</span>
                  </button>
                ))}
                {sugLoading && (
                  <div className="wiz-sug-note"><span className="wiz-sug-spin">⟳</span> listing directory…</div>
                )}
                {!sugLoading && sugNote && sug.length === 0 && (
                  <div className="wiz-sug-note">{sugNote}</div>
                )}
              </div>
            )}
            {pathError && (
              <div className="wiz-error">⚠ {pathError}
                {allowForce && (
                  <button type="button" className="wiz-btn ghost" onClick={() => void submitCustom(true)}>use anyway ›</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Name + launch ── */}
        {step === 'name' && vps && (
          <div className="wiz-body">
            <div className="wiz-label">Name <span className="wiz-opt">(optional)</span></div>
            <input
              className="wiz-name-input"
              autoFocus
              placeholder={kind === 'agent' ? 'e.g. sidebar redesign' : 'e.g. tail logs'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') launch(); }}
            />

            {kind === 'agent' && (
              <div className="wiz-adv">
                <button className="wiz-adv-toggle" onClick={() => setShowAdv((v) => !v)}>
                  {showAdv ? '▾' : '▸'} advanced · model{isCodex ? ', effort & sandbox' : ' & effort'}
                </button>
                {showAdv && (
                  <div className="wiz-adv-body">
                    {isCodex ? (
                      <>
                        <label className="wiz-adv-field">model
                          <CodexModelPicker vpsId={vps.id} value={model} onChange={setModel} inheritPlaceholder="Codex default" />
                        </label>
                        <label className="wiz-adv-field">effort
                          <CodexEffortPicker vpsId={vps.id} value={effort} onChange={setEffort} modelId={model} inheritPlaceholder="Codex default" />
                        </label>
                        <label className="wiz-adv-field">sandbox
                          <select value={codexSandbox} onChange={(e) => setCodexSandbox(e.target.value as CodexSandboxMode)}>
                            {CODEX_SANDBOX_MODES.map((m) => (
                              <option key={m} value={m}>{m} — {CODEX_MODE_DESC[m]}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="wiz-adv-field">model
                          <ModelPicker value={model} onChange={setModel} inheritPlaceholder={globalDefaults?.model || undefined} />
                        </label>
                        <label className="wiz-adv-field">fallback model
                          <ModelPicker value={fallbackModel} onChange={setFallbackModel} inheritPlaceholder={globalDefaults?.fallbackModel || 'none'} />
                        </label>
                        <label className="wiz-adv-field">effort
                          <EffortPicker value={effort} onChange={setEffort} modelId={model} inheritPlaceholder={globalDefaults?.effort || undefined} />
                        </label>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="wiz-summary">
              <KindIcon />
              <span>{kindLabel} · <b>{vps.name}</b> · <span className="mono">{path == null ? '~ (home)' : path}</span></span>
            </div>
            {err && <div className="wiz-error">⚠ {err}</div>}
            <div className="wiz-actions">
              <button className="wiz-btn ghost" onClick={() => setStep('path')} disabled={busy}>Back</button>
              <button className="wiz-btn primary big" onClick={launch} disabled={busy}>
                {busy ? 'launching…' : `▸ Launch ${kind === 'agent' ? 'agent' : 'shell'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Crumb({ n, label, active, done, disabled, onClick }: {
  n: number; label: string; active: boolean; done: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`wiz-crumb${active ? ' active' : ''}${done ? ' done' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="wiz-crumb-n">{done ? '✓' : n}</span>
      <span className="wiz-crumb-label">{label}</span>
    </button>
  );
}
