'use client';
import PickerControl from './PickerControl';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, sessionApi } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import AgentLogo from './AgentLogo';
import { useAccountProfiles } from './accountProfileStore';
import { DEFAULT_ACCOUNT_PROFILE, profileLabel, type AccountProfile } from '@/lib/accountProfiles';
import { AccountChoiceMark, AccountChoiceMenu, accountChoices, useAccountChoice, vpsForProfile } from './AccountChoice';
import { MODE_LABELS, providerName, providerText } from '@/lib/providerText';
import { IconRobot, IconTerminal } from './icons';
import type {
  AgentKind, CodexSessionConfig, ProviderSessionConfig, SessionPathResponse,
} from '@/lib/types/api';
import {
  SESSION_PROVIDERS, defaultSessionMode, hasEffortAxis, providerSettingKey,
  sessionCapabilities, sessionModes, supportsSessionCapability,
  type SessionMode,
} from '@/lib/sessionCapabilities';
import { PROVIDER_CATALOGS } from './modelPickers';
import { agentAvailability, backendAvailability, backendLauncher, type BackendLauncher, type VpsFix, type VpsFixAction } from './vpsHealth';
import { ALL_BACKENDS_ENABLED, enabledKinds, type EnabledBackends } from './enabledBackends';
import { useSearchAutoFocus, useVpsSearch } from './vpsSearch';
import SettingSourcesPicker from './SettingSourcesPicker';
import PathChooser, { knownPathsFor } from './PathChooser';
import {
  resolveSettingSources, safeParseSettingSources, type ClaudeSettingSource,
} from '@/lib/settingSources';

// 3-step "new session" wizard (prod). `kind` (agent vs shell) is fixed by the
// button that opened it. For agents, the BACKEND (Claude vs Codex) is either
// fixed (`agentKind` prop, from a per-VPS Claude/Codex button) or chosen in
// step 1 (the global "＋ Agent" button → VPS+backend picker).
//   1. pick a VPS (grouped by folder; for a backend-unfixed agent, each VPS
//      row exposes two buttons Claude/Codex; skipped when a VPS is passed in)
//   2. pick a path  (known paths + a custom one; "home" for shells)
//   3. name it (+ optional model/effort/mode for agents) and launch
// An agent launch whose VPS AND path are both given but whose backend is not
// (the session header's "＋ agent here") swaps steps 1-2 for ONE backend step
// on that VPS: backend → name. With `offerShell` that step also lists a shell,
// which turns the wizard into a shell launch on the same VPS and folder.
type Step = 'vps' | 'backend' | 'path' | 'name';
const DEFAULT_FOLDER_ID = 'default';

type Props = {
  kind: 'agent' | 'shell';
  /** The phone's "＋ agent" (§11): the backend step also offers a shell in
   *  the same VPS and folder. Only with `initialVpsId` + `initialCwd`. */
  offerShell?: boolean;
  // Backend for agent launches. When provided the wizard skips the
  // Claude/Codex picker (per-VPS ＋ button); when absent + kind==='agent' the
  // user chooses per VPS in step 1.
  agentKind?: AgentKind;
  initialAccountProfile?: string;
  onProfileLogin?: (vps: Vps, provider: AgentKind, profile: AccountProfile) => void;
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialVpsId?: string;
  initialCwd?: string | null;
  onClose: () => void;
  // The whole created row, not just the id: the caller has to open its tab
  // NOW, and the session list it would look the id up in is refreshed a beat
  // later (a lookup that misses = a session created and never selected).
  onCreatedSession?: (created: { id: string; vpsId: string; cwd: string }) => void;
  onCreatedShell?: (shell: ShellInfo) => void;
  // Repair button on an unavailable VPS row (cf. app/vpsHealth.tsx). The
  // parent decides what closes the wizard (install / claude-login do; a
  // refresh or update runs in place — the row repaints via the live vpsList
  // prop + the busy sets below).
  onFix?: (v: Vps, action: VpsFixAction) => void;
  refreshingAgentVpsIds?: Set<string>;
  updatingAgentVpsIds?: Set<string>;
  /** Backends this hub offers (Settings → Claude/Codex). Only enabled ones get
   *  a row here; with both off the wizard says so and links to Settings. */
  enabledBackends?: EnabledBackends;
  /** Opens Settings on that section (the link in the "no backend" notice). */
  onOpenSettings?: (section: 'claude' | 'codex') => void;
};

export default function NewSessionWizard({
  kind: openedAs, offerShell = false, agentKind, initialAccountProfile, onProfileLogin, vpsList, vpsFolders, vpsPaths, initialVpsId, initialCwd, onClose,
  onCreatedSession, onCreatedShell,
  onFix, refreshingAgentVpsIds, updatingAgentVpsIds,
  enabledBackends = ALL_BACKENDS_ENABLED, onOpenSettings,
}: Props) {
  const hasInitialCwd = typeof initialCwd === 'string' && initialCwd.trim() !== '';
  // Fixed by the button that opened the wizard, except where the backend
  // step offers a shell: its shell row switches it, a backend row back.
  const [kind, setKind] = useState<'agent' | 'shell'>(openedAs);
  const shellOffered = offerShell && openedAs === 'agent' && !!initialVpsId && hasInitialCwd;
  // Backends this hub offers. A switch in Settings, not an availability: a
  // disabled backend is not GREYED here, it is absent — and when both are off
  // the wizard is a notice pointing at the switch instead of a picker with
  // nothing to pick. (app/enabledBackends.ts)
  const allowedKinds = enabledKinds(enabledBackends);
  const noBackend = kind === 'agent' && allowedKinds.length === 0 && !shellOffered;
  // Backend is fixed by the caller (agentKind), trivially for shells, or by
  // there being exactly one enabled backend left to choose from.
  const fixedKind: AgentKind | null = kind !== 'agent'
    ? null
    : (agentKind && allowedKinds.includes(agentKind)) ? agentKind
    : allowedKinds.length === 1 ? allowedKinds[0]
    : null;
  const backendFixed = kind !== 'agent' || fixedKind != null;
  // Where the agent runs is already decided; only WHICH agent is left.
  const showBackendStep = shellOffered || (kind === 'agent' && !!initialVpsId && hasInitialCwd && !backendFixed);
  const [selKind, setSelKind] = useState<AgentKind>(fixedKind ?? allowedKinds[0] ?? 'claude');
  // A backend switched off in another tab while this wizard is open must not
  // leave the selection pointing at it (the settings bus is live, §9).
  useEffect(() => {
    if (kind !== 'agent' || allowedKinds.length === 0 || allowedKinds.includes(selKind)) return;
    setSelKind(fixedKind ?? allowedKinds[0]);
    // allowedKinds is rebuilt every render, so the real dep is the enabled
    // FLAGS. Joined rather than listed per provider: hand-naming two of them
    // meant switching the third off in another tab left this pointing at it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, selKind, fixedKind, allowedKinds.join(',')]);
  const profiles = useAccountProfiles();
  const [selProfile, setSelProfile] = useState(initialAccountProfile ?? 'default');
  const choicesFor = (v: Vps, k: AgentKind): AccountProfile[] => accountChoices(profiles, v.id, k);
  const profileVps = (v: Vps, k: AgentKind, id = selProfile): Vps =>
    vpsForProfile(v, k, choicesFor(v, k).find((p) => p.id === id));
  // A selection made for another VPS or backend falls back to that one's
  // default rather than reaching the server as a foreign profile.
  const ownProfile = (v: Vps, k: AgentKind, id: string) =>
    choicesFor(v, k).some((p) => p.id === id) ? id : DEFAULT_ACCOUNT_PROFILE;
  const [vpsId, setVpsId] = useState<string | null>(initialVpsId ?? null);
  const selectedProfile = profiles.find((p) => p.vpsId === (vpsId ?? '') && p.provider === selKind && p.id === selProfile);
  const [path, setPath] = useState<string | null>(hasInitialCwd ? initialCwd! : null);
  const [pathChosen, setPathChosen] = useState<boolean>(hasInitialCwd);
  const [name, setName] = useState('');
  const [custom, setCustom] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  // Step 2's input and its autocomplete live in PathChooser (shared with the
  // explorer's "open a folder"); what a submitted path MEANS stays here.
  const [checking, setChecking] = useState(false);      // existence check on "Use ›"
  const [allowForce, setAllowForce] = useState(false);  // "use anyway" after a failed check
  const [pathPreview, setPathPreview] = useState<{ key: string; result: SessionPathResponse } | null>(null);
  const [step, setStep] = useState<Step>(
    !initialVpsId ? 'vps' : !hasInitialCwd ? 'path' : showBackendStep ? 'backend' : 'name');
  // The enabled set arrives after mount (the panel starts from "all on"): once
  // it leaves a single backend, there is nothing left to choose.
  useEffect(() => {
    if (step === 'backend' && backendFixed && !shellOffered) setStep('name');
  }, [step, backendFixed, shellOffered]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // ── Step 1 filter (name / ip / project path — cf. app/vpsSearch.ts) ──
  // Auto-focused whenever step 1 is on screen, so "open the wizard → type"
  // narrows the list without a click.
  const [vpsQuery, setVpsQuery] = useState('');
  const vpsSearch = useVpsSearch(vpsQuery, vpsPaths);
  const vpsSearchRef = useSearchAutoFocus<HTMLInputElement>(step === 'vps');

  const capabilities = sessionCapabilities(selKind);

  // Optional per-session config (agent only). Blank = inherit the global
  // default (claude.default_* / codex.default_*). Codex has no fallback model
  // and its "mode" is a sandbox level (default workspace-write).
  const [showAdv, setShowAdv] = useState(false);
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState('');
  // The selected backend's permission/sandbox/freedom mode. ONE state for
  // every provider — filled from `sessionModes(selKind)` — because the picker
  // it feeds is the same control; it used to be Codex-only, which left the
  // third backend, whose mode IS its whole permission gate (§14.103), with no
  // per-session surface at all.
  const [sessionMode, setSessionMode] = useState<SessionMode | ''>('');
  const [baseInstructions, setBaseInstructions] = useState('');
  const [developerInstructions, setDeveloperInstructions] = useState('');
  const [codexOverrides, setCodexOverrides] = useState('');
  const [outputSchemaText, setOutputSchemaText] = useState('');
  const [codexSummary, setCodexSummary] = useState<'auto' | 'concise' | 'detailed' | 'none'>('auto');
  const [codexPersonality, setCodexPersonality] = useState<'friendly' | 'pragmatic' | 'none'>('pragmatic');
  const [codexServiceTier, setCodexServiceTier] = useState<'fast' | 'flex'>('fast');
  const [codexEphemeral, setCodexEphemeral] = useState(false);
  const [codexModelProvider, setCodexModelProvider] = useState('');
  const [sessionEnv, setSessionEnv] = useState('');
  const [codexBin, setCodexBin] = useState('');
  const [claudeSkills, setClaudeSkills] = useState('');
  // §14.100 — null while the user hasn't touched it: the session then inherits
  // the VPS's scope (or the hub default). Claude only; Codex has no equivalent.
  const [settingSources, setSettingSources] = useState<ClaudeSettingSource[] | null>(null);
  const [globalDefaults, setGlobalDefaults] = useState<{
    model: string; fallbackModel: string; effort: string;
    /** Fleet default mode, per provider — labels the picker's "default" row. */
    modes: Partial<Record<AgentKind, string>>;
    settingSources: ClaudeSettingSource[];
  } | null>(null);

  // Enter validates the CURRENT step, wherever focus is. Each step's own
  // control handles Enter itself (search box, path input, name input); this is
  // the fallback for a focus that ended up nowhere — clicking a suggestion, a
  // crumb, or arriving on step 2 on a touch device. Kept in a ref so the
  // listener never re-registers and never captures a stale `custom`/`name`.
  const enterActionRef = useRef<() => void>(() => {});
  useEffect(() => {
    enterActionRef.current = () => {
      if (step === 'name') { void launch(); return; }
      if (step === 'path' && custom.trim()) { void submitCustom(); return; }
      if (step === 'backend') { pickObviousBackend(); return; }
      if (step === 'vps') pickObviousVps();
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      // A focused control answers Enter on its own (inputs submit, a button
      // activates, a <select> opens) — firing on top of it would double-act.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'select') return;
      if (t?.isContentEditable) return;
      e.preventDefault();
      enterActionRef.current();
    };
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
        modes: Object.fromEntries(SESSION_PROVIDERS.map((p) => [
          p,
          s[providerSettingKey(p, 'default_permission_mode')] || defaultSessionMode(p, 'create'),
        ])),
        settingSources: resolveSettingSources(
          safeParseSettingSources(s['claude.setting_sources'])),
      }))
      .catch(() => {});
  }, [kind]);

  // Reset per-backend config when the backend switches (model ids / efforts
  // aren't comparable across Claude and Codex).
  useEffect(() => {
    setModel(''); setFallbackModel(''); setEffort(''); setSessionMode('');
  }, [selKind]);

  const vps = vpsId ? vpsList.find((v) => v.id === vpsId) ?? null : null;
  // What this session gets if the user leaves the picker alone (§14.100): the
  // VPS's own scope, else the fleet default, else the built-in one. Resolved
  // here purely to LABEL the inherit option — the server resolves it again for
  // real and persists the answer.
  const inheritedSettingSources = resolveSettingSources(
    safeParseSettingSources(vps?.claudeSettingSources),
    globalDefaults?.settingSources,
  );
  // Until a backend is picked the title must not name one: `selKind` is only a
  // placeholder there, and "New Claude agent" above a Claude/Codex/Cursor
  // choice reads as if the choice were already made.
  const backendChosen = (backendFixed && !shellOffered) || (step !== 'vps' && step !== 'backend');
  const choosingKind = shellOffered && step === 'backend';
  const agentLabel = backendChosen ? providerText.agentNoun(selKind) : 'agent';
  const kindLabel = choosingKind ? 'agent or shell' : kind === 'agent' ? agentLabel : 'SSH shell';
  const KindIcon = choosingKind
    ? () => <IconRobot />
    : kind !== 'agent'
    ? () => <IconTerminal />
    : backendChosen ? () => <AgentLogo kind={selKind} profileNumber={selectedProfile?.number} size={15} /> : () => <IconRobot />;

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

  // Same buckets, narrowed by the search box; a folder with no hit vanishes.
  const shownBuckets = useMemo(() => {
    if (!vpsSearch.active) return buckets;
    return buckets
      .map((b) => ({ folder: b.folder, vps: b.vps.filter((v) => vpsSearch.match(v).ok) }))
      .filter((b) => b.vps.length > 0);
  }, [buckets, vpsSearch]);
  const shownVps = useMemo(() => shownBuckets.flatMap((b) => b.vps), [shownBuckets]);

  const pickList = useMemo(() => knownPathsFor(vps, vpsPaths), [vps, vpsPaths]);

  // Per-VPS availability — shared diagnosis (app/vpsHealth.tsx). Sessions
  // need the whole stack for their backend; a shell only needs the agent
  // layer (ssh + daemon). Each row shows the precise blocker + its fix.
  const availFor = (v: Vps, k: AgentKind, profile = selProfile) => backendAvailability(profileVps(v, k, profile), k);

  // The blockers to paint under a row, each PAIRED with its own repair
  // button ("⚠ reason [fix]" per line — never a detached button cluster).
  // Agent-layer problems (ssh / no agent / daemon down) are common to both
  // backends → ONE pair; otherwise one pair per broken backend.
  function rowIssues(v: Vps): { text: string; fix?: VpsFix }[] {
    const agent = agentAvailability(v);
    if (!agent.ok) return [{ text: agent.reason, fix: agent.fix }];
    if (kind !== 'agent') return [];
    const out: { text: string; fix?: VpsFix }[] = [];
    const kinds: AgentKind[] = backendFixed ? [selKind] : allowedKinds;
    for (const k of kinds) {
      const av = backendAvailability(v, k);
      if (av.ok) continue;
      // A SIGN-IN blocker is carried by that backend's own button now — it
      // opens the modal itself — so repeating it here would restore exactly the
      // second control this design removes. A missing RUNTIME still gets its
      // row: installing is not something a launcher may start (`vpsHealth §
      // backendLauncher`).
      if (backendLauncher(v, k).fix) continue;
      out.push({
        text: backendFixed ? av.reason : providerText.blocker(k, av.reason),
        fix: av.fix,
      });
    }
    return out;
  }
  const fixBusy = (v: Vps, action: VpsFixAction) =>
    (action === 'refresh' && !!refreshingAgentVpsIds?.has(v.id)) ||
    (action === 'update' && !!updatingAgentVpsIds?.has(v.id));

  function pickVps(v: Vps, k?: AgentKind, chosen?: string) {
    const backend = k ?? selKind;
    const profile = chosen ?? ownProfile(v, backend, selProfile);
    if (kind === 'agent') {
      if (!availFor(v, backend, profile).ok) return;
      setSelKind(backend);
      setSelProfile(profile);
    } else if (!agentAvailability(v).ok) {
      return; // a shell still needs the agent up
    }
    setVpsId(v.id);
    setPath(null); setPathChosen(false);
    setStep('path');
  }
  // Enter on step 1 = "take the obvious one": only when the list is down to
  // EXACTLY one usable VPS (and, for a backend-free agent launch, only one
  // usable backend) — otherwise typing blind could start a session on the
  // wrong machine.
  function pickObviousVps() {
    if (shownVps.length !== 1) return;
    const v = shownVps[0];
    if (kind !== 'agent') {
      if (agentAvailability(v).ok) pickVps(v);
      return;
    }
    if (backendFixed) {
      if (availFor(v, selKind).ok) pickVps(v);
      return;
    }
    const usable = allowedKinds.filter((k) => availFor(v, k).ok);
    if (usable.length === 1) pickVps(v, usable[0]);
  }
  function pickBackend(k: AgentKind, profile: string = DEFAULT_ACCOUNT_PROFILE) {
    if (!vps || !availFor(vps, k, profile).ok) return;
    setKind('agent');
    setSelKind(k);
    setSelProfile(profile);
    setStep('name');
  }
  // Same rule as step 1: Enter only takes a backend when it is the ONLY one
  // that can start here.
  function pickObviousBackend() {
    if (!vps) return;
    const usable = allowedKinds.filter((k) => availFor(vps, k).ok);
    const shellUsable = shellOffered && agentAvailability(vps).ok;
    if (usable.length === 1 && !shellUsable) pickBackend(usable[0]);
    else if (usable.length === 0 && shellUsable) pickShell();
  }
  function pickShell() {
    if (!vps || !agentAvailability(vps).ok) return;
    setKind('shell');
    setStep('name');
  }
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && vpsQuery) {
      // Clear the filter instead of closing the wizard (the window-level
      // Escape listener sits behind this stopPropagation).
      e.stopPropagation(); setVpsQuery(''); return;
    }
    if (e.key === 'Enter') pickObviousVps();
  }

  function choosePath(p: string | null) {
    setPath(p); setPathChosen(true); setPathError(null);
    setStep('name');
  }

  // Read-only preview; cancel stale results when the path or VPS changes.
  const previewPath = step === 'path' ? custom.trim() : (path?.trim() ?? '');
  const previewKey = `${vpsId}:${previewPath}`;
  const currentPreview = pathPreview?.key === previewKey ? pathPreview.result : null;
  const previewNote = kind !== 'agent' || !currentPreview ? null
    : currentPreview.ok
      ? (currentPreview.exists ? null : { err: false, text: 'This directory will be created when the session starts.' })
      : { err: true, text: currentPreview.error };
  useEffect(() => {
    if (kind !== 'agent' || !vpsId || !previewPath || step === 'vps') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.checkSessionPath(vpsId, previewPath)
        .then((result) => { if (!cancelled) setPathPreview({ key: previewKey, result }); })
        .catch(() => { if (!cancelled) setPathPreview({ key: previewKey, result: { ok: false, error: 'The directory could not be verified on the VPS.' } }); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [kind, vpsId, previewPath, previewKey, step]);

  // Agent paths must exist or have exactly one missing leaf. The legacy
  // shell picker retains its existence check and "use anyway" escape hatch.
  async function submitCustom(force = false) {
    const p = custom.trim();
    if (!p) { setPathError('enter a path'); return; }
    if (!vps || (force && kind === 'shell') || checking) { if (!checking) choosePath(p); return; }
    setChecking(true);
    try {
      if (kind === 'agent') {
        const result = await api.checkSessionPath(vps.id, p);
        setPathPreview({ key: `${vps.id}:${p}`, result });
        setAllowForce(false);
        if (!result.ok) { setPathError(result.error); return; }
        choosePath(result.resolved ?? p);
        return;
      }
      const r = await api.listVpsDirs(vps.id, p);
      if (r.ok && r.exists === false) {
        setPathError(`this directory does not exist on ${vps.name}`);
        setAllowForce(true);
        return;
      }
      if (r.ok && r.exists && r.resolved) { choosePath(r.resolved); return; }
    } catch {
      if (kind === 'agent') { setPathError('The directory could not be verified on the VPS.'); return; }
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
        let outputSchema: Record<string, unknown> | null = null;
        if (outputSchemaText.trim()) {
          const parsed = JSON.parse(outputSchemaText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('output schema must be a JSON object');
          outputSchema = parsed;
        }
        const env: Record<string, string> = {};
        for (const line of sessionEnv.split('\n').map((v) => v.trim()).filter(Boolean)) {
          const split = line.indexOf('=');
          if (split < 1) throw new Error(`invalid env line: ${line}`);
          const key = line.slice(0, split).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env name: ${key}`);
          env[key] = line.slice(split + 1);
        }
        const shared = {
          accountProfile: selProfile,
          outputSchema,
          baseInstructions: baseInstructions.trim() || null,
          developerInstructions: developerInstructions.trim() || null,
          env,
        };
        // One branch PER PROVIDER, not `isCodex ? … : …`: that shape gave the
        // third backend Claude's config shape, whose fields it reads none of —
        // the wizard validated an output schema and an env block and then the
        // session silently ignored both (§14.102).
        let sessionConfig: ProviderSessionConfig | null;
        if (selKind === 'codex') {
          sessionConfig = {
            ...shared,
            configOverrides: codexOverrides.split('\n').map((v) => v.trim()).filter(Boolean),
            summary: codexSummary,
            personality: codexPersonality,
            serviceTier: codexServiceTier,
            ephemeral: codexEphemeral,
            modelProvider: codexModelProvider.trim() || null,
            codexBin: codexBin.trim() || null,
          } satisfies CodexSessionConfig;
        } else if (selKind === 'claude') {
          const skills = claudeSkills.split('\n').map((v) => v.trim()).filter(Boolean);
          sessionConfig = {
            ...shared,
            skills: skills.length ? skills : null,
            // Omitted (not null) when inheriting: the server fills it from the
            // VPS → hub chain and persists the result (§14.100).
            ...(settingSources ? { settingSources } : {}),
          };
        } else {
          // Cursor: no instruction/schema/env surface at all. The mode carries
          // the auto-review choice and the server resolves the rest.
          sessionConfig = null;
        }
        const r = await sessionApi.create({
          vpsId: vps.id, cwd: path!.trim(),
          name: name.trim() || null,
          kind: selKind,
          // Blank means the installation default. The server resolves and
          // persists it atomically, so a slow settings fetch cannot race this.
          permissionMode: sessionMode || undefined,
          model: model.trim() || null,
          // Codex has no fallback-model concept (server ignores it anyway).
          fallbackModel: capabilities.fallbackModel === 'none' ? null : (fallbackModel.trim() || null),
          effort: effort || null,
          sessionConfig,
        });
        onCreatedSession?.({ id: r.id, vpsId: vps.id, cwd: r.cwd });
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

  // ONE size per page: the box opens each step at its natural height, then
  // keeps it while that step lives — a filter, a listing, a verdict or an
  // error never resizes it (they scroll, float or use a reserved line). Only a
  // new page re-measures, and the advanced block counts as one: opening it is
  // a request for room. Imperative on purpose: React never owns this style,
  // and the layout effect runs before paint, so no frame shows the old size.
  const modalRef = useRef<HTMLDivElement | null>(null);
  const multiAccount = !!vps && kind === 'agent' && choicesFor(vps, selKind).length > 1;
  const pageKey = `${step}|${kind}|${selKind}|${showAdv}|${multiAccount}|${noBackend}`;
  useLayoutEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    el.style.height = '';
    el.style.height = `${Math.ceil(el.getBoundingClientRect().height)}px`;
  }, [pageKey]);

  const pathLabel = pathChosen ? (path == null ? '~ (home)' : path) : 'Path';

  // Both backends switched off in Settings: there is nothing to pick, so the
  // wizard is one sentence and the way to undo it. The generic "＋ Agent"
  // button deliberately stays in the sidebar (only the per-backend ones go
  // away), so "where did my agents go" is answered in one click instead of
  // looking like a bug.
  if (noBackend) {
    return (
      <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="claude-modal wizard kind-agent">
          <button className="modal-close" onClick={onClose}>✕</button>
          <div className="wiz-head">
            <span className="wiz-kind"><IconRobot /> New agent</span>
          </div>
          <div className="wiz-body">
            <div className="wiz-no-backend">
              <p>Claude and Codex are both turned off, so there is no agent to start.</p>
              <p>Turn at least one back on in <b>Settings → Agents</b>.</p>
              {onOpenSettings && (
                <button type="button" className="wiz-btn primary" onClick={() => onOpenSettings('claude')}>
                  Open Settings
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} className={`claude-modal wizard kind-${kind}`}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="wiz-head">
          <span className="wiz-kind"><KindIcon /> New {kindLabel}</span>
        </div>

        {showBackendStep ? (
          <div className="wiz-crumbs">
            <Crumb n={1} label={!backendChosen ? (shellOffered ? 'Agent or shell' : 'Agent') : kind === 'shell' ? 'Shell' : providerName(selKind)} active={step === 'backend'}
              done={backendChosen} onClick={() => setStep('backend')} />
            <span className="wiz-crumb-sep">▸</span>
            <Crumb n={2} label="Name" active={step === 'name'} done={false}
              disabled={!backendChosen} onClick={() => backendChosen && setStep('name')} />
          </div>
        ) : (
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
        )}

        {/* ── Backend on a known VPS + path (header "＋ agent here") ── */}
        {step === 'backend' && vps && (() => {
          const agentUp = agentAvailability(vps);
          return (
            <div className="wiz-body">
              <div className="wiz-label">{shellOffered ? 'Choose an agent or a shell' : 'Choose an agent'}</div>
              <div className="wiz-where">
                <span className={`wiz-pick-dot agent-${(vps as any).agentStatus ?? 'unknown'}`} />
                <b>{vps.name}</b>
                <span className="mono">{path}</span>
              </div>
              {/* The agent layer is common to every backend: ONE "reason [fix]"
                  line, not the same one repeated under each row. */}
              {!agentUp.ok && (
                <div className="wiz-issue wiz-where-issue">
                  <span className="wiz-issue-text">⚠ {agentUp.reason}</span>
                  {onFix && agentUp.fix && (
                    <button type="button" className="wiz-fix-btn"
                      disabled={fixBusy(vps, agentUp.fix.action)} title={agentUp.fix.title}
                      onClick={() => onFix(vps, agentUp.fix!.action)}
                    >{fixBusy(vps, agentUp.fix.action) ? '⟳ …' : agentUp.fix.label}</button>
                  )}
                </div>
              )}
              <div className="wiz-pick-list">
                {allowedKinds.map((k) => {
                  // Same launcher rule as the step-1 buttons (`vpsHealth §
                  // backendLauncher`): signed out ⇒ the row signs in; a missing
                  // runtime stays unpressable, its reason + repair inline.
                  const launcher = backendLauncher(vps, k);
                  if (!launcher.enabled) {
                    const av = backendAvailability(vps, k);
                    return (
                      <div key={k} className="wiz-pick static disabled wiz-backend-row">
                        <AgentLogo kind={k} size={20} />
                        <span className="wiz-pick-main">
                          <span className="wiz-pick-name">{providerName(k)}</span>
                          {agentUp.ok && (
                            <span className="wiz-issue">
                              <span className="wiz-issue-text">⚠ {av.reason}</span>
                              {onFix && av.fix && (
                                <button type="button" className="wiz-fix-btn"
                                  disabled={fixBusy(vps, av.fix.action)} title={av.fix.title}
                                  onClick={() => onFix(vps, av.fix!.action)}
                                >{fixBusy(vps, av.fix.action) ? '⟳ …' : av.fix.label}</button>
                              )}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <WizardBackendRow key={k} vps={vps} provider={k} profiles={choicesFor(vps, k)}
                      onLaunch={(profile, l) => {
                        if (l.ready) pickBackend(k, profile.id);
                        else if (profile.number > 1) onProfileLogin?.(vps, k, profile);
                        else if (l.fix) onFix?.(vps, l.fix.action);
                      }} />
                  );
                })}
                {/* A shell needs the agent only: its reason + repair is the
                    common line above. */}
                {shellOffered && (
                  <button type="button" className="wiz-pick wiz-backend-row wiz-shell-row"
                    disabled={!agentUp.ok} onClick={pickShell}
                    title={agentUp.ok ? 'New SSH shell in this folder' : agentUp.reason}>
                    <IconTerminal className="wiz-shell-glyph" />
                    <span className="wiz-pick-main">
                      <span className="wiz-pick-name">Shell</span>
                      <span className="wiz-pick-sub">SSH terminal in this folder</span>
                    </span>
                    <span className="wiz-pick-go">›</span>
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── Step 1: VPS (+ backend, when the agent backend isn't fixed) ── */}
        {step === 'vps' && (
          <div className="wiz-body">
            <div className="wiz-label">
              {kind === 'agent' && !backendFixed ? 'Choose a VPS & backend' : 'Choose a VPS'}
            </div>
            <div className="wiz-search">
              <span className="wiz-search-glyph">⌕</span>
              <input
                ref={vpsSearchRef}
                placeholder="filter — name, ip or project path…"
                value={vpsQuery}
                onChange={(e) => setVpsQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
              {vpsSearch.active && (
                <span className="wiz-search-count">{shownVps.length}/{vpsList.length}</span>
              )}
              {vpsQuery && (
                <button type="button" className="wiz-search-clear"
                  title="clear the filter (Esc)"
                  onClick={() => { setVpsQuery(''); vpsSearchRef.current?.focus(); }}
                >✕</button>
              )}
            </div>
            {buckets.length === 0 && <div className="wiz-error">no VPS — add one in « manage VPS »</div>}
            {buckets.length > 0 && shownBuckets.length === 0 && (
              <div className="wiz-empty">no VPS matches « {vpsQuery.trim()} »</div>
            )}
            {shownBuckets.map(({ folder, vps: list }) => (
              <div key={folder.id} className="wiz-folder">
                <div className="wiz-folder-name">▤ {folder.name}</div>
                <div className="wiz-pick-list">
                  {list.map((v) => {
                    const status = (v as any).agentStatus ?? 'unknown';
                    const issues = rowIssues(v);
                    // Why this row survived a project-path search — without it
                    // a row matched on a path the row doesn't show looks random.
                    const matched = vpsSearch.active ? vpsSearch.match(v).paths : [];
                    const matchEl = matched.length === 0 ? null : (
                      <span className="wiz-pick-sub mono wiz-pick-match" title={matched.join('\n')}>
                        ▤ {matched.slice(0, 2).join('  ·  ')}
                        {matched.length > 2 ? `  +${matched.length - 2}` : ''}
                      </span>
                    );
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
                      return (
                        <div key={v.id} className="wiz-pick static">
                          <span className={`wiz-pick-dot agent-${status}`} />
                          <span className="wiz-pick-main">
                            <span className="wiz-pick-name">{v.name}</span>
                            <span className="wiz-pick-sub">{v.sshUser}@{v.ip}</span>
                            {matchEl}
                            {issuesEl}
                          </span>
                          <span className="wiz-kind-btns">
                            {allowedKinds.map((k) => (
                              <WizardKindButton key={k} vps={v} provider={k} profiles={choicesFor(v, k)}
                                onLaunch={(profile, l) => {
                                  if (l.ready) pickVps(v, k, profile.id);
                                  else if (profile.number > 1) onProfileLogin?.(v, k, profile);
                                  else if (l.fix) onFix?.(v, l.fix.action);
                                }} />
                            ))}
                          </span>
                        </div>
                      );
                    }
                    // Shell OR fixed-backend agent: single clickable row. A
                    // shell needs the agent layer too (shell_start is an agent
                    // RPC) — same gating, minus the login/backend checks.
                    // A fixed-backend row IS the button, so it follows the same
                    // rule: signed out ⇒ still pressable, and it signs in.
                    const rowLauncher = kind === 'agent' ? backendLauncher(profileVps(v, selKind), selKind) : null;
                    const disabled = rowLauncher ? !rowLauncher.enabled : !agentAvailability(v).ok;
                    if (disabled) {
                      // Not a <button>: the row hosts the repair buttons
                      // (nested <button> is invalid HTML) and isn't clickable.
                      return (
                        <div key={v.id} className="wiz-pick static disabled">
                          <span className={`wiz-pick-dot agent-${status}`} />
                          <span className="wiz-pick-main">
                            <span className="wiz-pick-name">{v.name}</span>
                            <span className="wiz-pick-sub">{v.sshUser}@{v.ip}</span>
                            {matchEl}
                            {issuesEl}
                          </span>
                        </div>
                      );
                    }
                    const rowBlocked = rowLauncher && !rowLauncher.ready ? rowLauncher : null;
                    return (
                      <button key={v.id}
                        className={`wiz-pick${rowBlocked ? ' needs-fix' : ''}`}
                        title={rowBlocked ? rowBlocked.title : undefined}
                        onClick={() => {
                          if (rowBlocked?.fix) onFix?.(v, rowBlocked.fix.action);
                          else pickVps(v);
                        }}
                      >
                        <span className={`wiz-pick-dot agent-${status}`} />
                        <span className="wiz-pick-main">
                          <span className="wiz-pick-name">{v.name}</span>
                          <span className="wiz-pick-sub">{v.sshUser}@{v.ip}</span>
                          {matchEl}
                          {rowBlocked && <span className="wiz-pick-sub wiz-pick-blocked">⚠ {rowBlocked.title}</span>}
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
            <PathChooser
              vpsId={vps.id}
              label={<>Path on <b>{vps.name}</b></>}
              known={pickList}
              leading={kind === 'shell' && (
                <button className="wiz-pick" onClick={() => choosePath(null)}>
                  <span className="wiz-pick-glyph">~</span>
                  <span className="wiz-pick-main">
                    <span className="wiz-pick-name">home</span>
                    <span className="wiz-pick-sub">the SSH user's home directory</span>
                  </span>
                  <span className="wiz-pick-go">›</span>
                </button>
              )}
              value={custom}
              onChange={(v) => { setCustom(v); setPathError(null); setAllowForce(false); }}
              onChoose={choosePath}
              onSubmit={() => void submitCustom()}
              busy={checking}
              // A failed "Use ›" outranks the live preview.
              status={pathError ? <>⚠ {pathError}
                {allowForce && (
                  <button type="button" className="wiz-btn ghost" onClick={() => void submitCustom(true)}>use anyway ›</button>
                )}
              </> : previewNote?.text}
              statusError={!!pathError || !!previewNote?.err}
              note={previewNote}
              error={pathError}
            />
          </div>
        )}

        {/* ── Step 3: Name + launch ── the summary and the buttons stay
            pinned under the body, which scrolls once the advanced block is
            taller than the screen allows. */}
        {step === 'name' && vps && (<>
          <div className="wiz-body">
            {kind === 'agent' && choicesFor(vps, selKind).length > 1 && <label className="nw-field profile-picker">
              <span>Account</span>
              <PickerControl value={selProfile} onValueChange={(id) => setSelProfile(String(id))}>
                {choicesFor(vps, selKind).map((profile) => <option value={profile.id} key={profile.id}>
                  {profileLabel(providerName(selKind), profile)}{profile.loggedIn === false ? ' · Sign in required' : ''}
                </option>)}
              </PickerControl>
              {choicesFor(vps, selKind).find((p) => p.id === selProfile)?.loggedIn === false && <button type="button" className="wiz-btn ghost"
                onClick={() => { const profile = choicesFor(vps, selKind).find((p) => p.id === selProfile); if (profile) onProfileLogin?.(vps, selKind, profile); }}>Sign in to this account</button>}
            </label>}
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
                  {showAdv ? '▾' : '▸'} advanced · model, effort & instructions
                </button>
                {showAdv && (
                  <div className="wiz-adv-body">
                    {/* Model and effort come from the SELECTED backend's own
                        catalog (§14.102). They used to sit inside an
                        `isCodex ? … : …`, which offered a third provider
                        Claude's models — a picker listing what its backend
                        cannot run, with a green typecheck. */}
                    {(() => {
                      const { Model, Effort } = PROVIDER_CATALOGS[selKind];
                      const inherit = providerText.agentLabel(selKind) + ' default';
                      return (
                        <>
                          <label className="wiz-adv-field">model
                            <Model accountProfile={selProfile} vpsId={vps.id} value={model} onChange={setModel}
                              inheritPlaceholder={globalDefaults?.model || inherit} />
                          </label>
                          {supportsSessionCapability(selKind, 'fallbackModel') && (
                            <label className="wiz-adv-field">fallback model
                              <Model accountProfile={selProfile} vpsId={vps.id} value={fallbackModel} onChange={setFallbackModel}
                                inheritPlaceholder={globalDefaults?.fallbackModel || 'none'} />
                            </label>
                          )}
                          {hasEffortAxis(selKind) && (
                            <label className="wiz-adv-field">effort
                              <Effort accountProfile={selProfile} vpsId={vps.id} value={effort} onChange={setEffort} modelId={model}
                                inheritPlaceholder={globalDefaults?.effort || inherit} />
                            </label>
                          )}
                        </>
                      );
                    })()}
                    {/* The mode, for EVERY backend — filled from
                        `sessionModes(selKind)` and worded by the shared
                        MODE_LABELS. Offered only under `isCodex`, the third
                        backend had no per-session way to pick its freedom
                        rung, which for it IS the whole permission gate. */}
                    <label className="wiz-adv-field">mode
                      <PickerControl value={sessionMode} onValueChange={(nextValue) => setSessionMode(nextValue as SessionMode | '')}>
                        <option value="">
                          default — {globalDefaults?.modes?.[selKind] ?? defaultSessionMode(selKind, 'create')}
                        </option>
                        {sessionModes(selKind).map((m) => (
                          <option key={m} value={m}>{MODE_LABELS[m] ?? m}</option>
                        ))}
                      </PickerControl>
                    </label>
                    {selKind === 'codex' && (
                      <>
                        <label className="wiz-adv-field">personality
                          <PickerControl value={codexPersonality} onValueChange={(nextValue) => setCodexPersonality(nextValue as any)}>
                            <option value="friendly">friendly</option><option value="pragmatic">pragmatic</option><option value="none">none</option>
                          </PickerControl>
                        </label>
                        <label className="wiz-adv-field">reasoning summary
                          <PickerControl value={codexSummary} onValueChange={(nextValue) => setCodexSummary(nextValue as any)}>
                            <option value="auto">auto</option><option value="concise">concise</option>
                            <option value="detailed">detailed</option><option value="none">none</option>
                          </PickerControl>
                        </label>
                        <label className="wiz-adv-field">service tier
                          <PickerControl value={codexServiceTier} onValueChange={(nextValue) => setCodexServiceTier(nextValue as any)}>
                            <option value="fast">fast</option><option value="flex">flex</option>
                          </PickerControl>
                        </label>
                        <label className="wiz-adv-field">base instructions
                          <textarea value={baseInstructions} onChange={(e) => setBaseInstructions(e.target.value)} placeholder="system-level instructions for this thread" />
                        </label>
                        <label className="wiz-adv-field">developer instructions
                          <textarea value={developerInstructions} onChange={(e) => setDeveloperInstructions(e.target.value)} placeholder="project conventions and constraints" />
                        </label>
                        <label className="wiz-adv-field">config overrides <span className="wiz-opt">(one key=value per line)</span>
                          <textarea className="mono" value={codexOverrides} onChange={(e) => setCodexOverrides(e.target.value)} placeholder={'features.foo=true\nmcp_servers.docs.enabled=true'} />
                        </label>
                        <label className="wiz-adv-field">output schema <span className="wiz-opt">(JSON object)</span>
                          <textarea className="mono" value={outputSchemaText} onChange={(e) => setOutputSchemaText(e.target.value)} placeholder={'{"type":"object","properties":{}}'} />
                        </label>
                        <label className="wiz-adv-field">model provider
                          <input value={codexModelProvider} onChange={(e) => setCodexModelProvider(e.target.value)} placeholder="default provider" />
                        </label>
                        <label className="wiz-adv-field">environment <span className="wiz-opt">(KEY=value per line)</span>
                          <textarea className="mono" value={sessionEnv} onChange={(e) => setSessionEnv(e.target.value)} />
                        </label>
                        <label className="wiz-adv-field">{providerText.binaryPath('codex')}
                          <input className="mono" value={codexBin} onChange={(e) => setCodexBin(e.target.value)} placeholder="SDK bundled binary" />
                        </label>
                        <label className="wiz-adv-check">
                          <input type="checkbox" checked={codexEphemeral} onChange={(e) => setCodexEphemeral(e.target.checked)} />
                          ephemeral thread (not kept in ~/.codex)
                        </label>
                      </>
                    )}
                    {/* ⚠ Instructions / output schema / env are NOT
                        provider-neutral: they exist only where the backend's
                        construction options carry them. Rendered in a
                        `isCodex ? … : else` branch, they were offered for a
                        third backend that reads none of them — validated on
                        launch, then silently dropped (§14.102). Independent
                        `selKind ===` guards, so provider n+1 renders nothing
                        rather than inheriting someone else's block. */}
                    {selKind === 'claude' && (
                      <>
                        <label className="wiz-adv-field">base instructions
                          <textarea value={baseInstructions} onChange={(e) => setBaseInstructions(e.target.value)} placeholder="instructions appended to the backend's own system prompt" />
                        </label>
                        <label className="wiz-adv-field">developer instructions
                          <textarea value={developerInstructions} onChange={(e) => setDeveloperInstructions(e.target.value)} placeholder="project conventions and constraints" />
                        </label>
                        <label className="wiz-adv-field">output schema <span className="wiz-opt">(JSON object)</span>
                          <textarea className="mono" value={outputSchemaText} onChange={(e) => setOutputSchemaText(e.target.value)} placeholder={'{"type":"object","properties":{}}'} />
                        </label>
                        {/* This backend's OWN mechanism: its skill filter and
                            its settings-file chain (§14.100), whose scope words
                            mean nothing to another runtime. */}
                        <label className="wiz-adv-field">skills <span className="wiz-opt">(one name per line; blank = CLI defaults)</span>
                          <textarea className="mono" value={claudeSkills} onChange={(e) => setClaudeSkills(e.target.value)} placeholder={'code-review\nfrontend-design'} />
                        </label>
                        <div className="wiz-adv-field">settings files <span className="wiz-opt">(what this session reads)</span>
                          <SettingSourcesPicker
                            value={settingSources}
                            onChange={setSettingSources}
                            inherited={inheritedSettingSources}
                          />
                        </div>
                        <label className="wiz-adv-field">environment <span className="wiz-opt">(KEY=value per line)</span>
                          <textarea className="mono" value={sessionEnv} onChange={(e) => setSessionEnv(e.target.value)} />
                        </label>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="wiz-foot">
            <div className="wiz-summary">
              <KindIcon />
              <span>{kindLabel} · <b>{vps.name}</b> · <span className="mono">{path == null ? '~ (home)' : path}</span></span>
            </div>
            {/* Reserved like step 2's: the path check answers after the page
                is measured. A launch failure outranks it. */}
            <div className={`wiz-status${err || previewNote?.err ? ' is-error' : ''}`} role="status">
              {err ? `⚠ ${err}` : previewNote?.text}
            </div>
            <div className="wiz-actions">
              <button className="wiz-btn ghost" onClick={() => setStep(showBackendStep ? 'backend' : 'path')} disabled={busy}>Back</button>
              <button className="wiz-btn primary big" onClick={launch} disabled={busy}>
                {busy ? 'launching…' : `▸ Launch ${kind === 'agent' ? 'agent' : 'shell'}`}
              </button>
            </div>
          </div>
        </>)}
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

type AccountLaunch = (profile: AccountProfile, launcher: BackendLauncher) => void;

/** Step-1 backend button of a VPS row. Several accounts stay ONE button: it
 *  opens the account choice in place (`AccountChoice.tsx`). */
function WizardKindButton({ vps, provider, profiles, onLaunch }: {
  vps: Vps; provider: AgentKind; profiles: AccountProfile[]; onLaunch: AccountLaunch;
}) {
  const choice = useAccountChoice(profiles.length);
  const launcherOf = (p: AccountProfile) => backendLauncher(vpsForProfile(vps, provider, p), provider);
  const launcher = launcherOf(profiles[0]);
  const warn = choice.multi ? !profiles.some((p) => launcherOf(p).ready) : launcher.warn;
  return (
    <>
      <button type="button" {...choice.trigger}
        className={`wiz-kind-btn${warn ? ' needs-fix' : ''}${choice.multi ? ' has-accounts' : ''}`}
        disabled={!launcher.enabled}
        title={choice.multi ? providerText.accountsLauncher(provider, profiles.length) : launcher.title}
        onClick={(e) => { if (!choice.takeClick(e)) onLaunch(profiles[0], launcher); }}>
        {choice.multi && <AccountChoiceMark />}
        <AgentLogo kind={provider} size={15} />
        <span>{providerName(provider)}</span>
        {warn && <span className="wiz-kind-warn" aria-hidden="true">!</span>}
      </button>
      <AccountChoiceMenu choice={choice} vps={vps} provider={provider} profiles={profiles} onPick={onLaunch} />
    </>
  );
}

/** Backend-step row ("＋ agent here"): same account choice, row-sized. */
function WizardBackendRow({ vps, provider, profiles, onLaunch }: {
  vps: Vps; provider: AgentKind; profiles: AccountProfile[]; onLaunch: AccountLaunch;
}) {
  const choice = useAccountChoice(profiles.length);
  const launcherOf = (p: AccountProfile) => backendLauncher(vpsForProfile(vps, provider, p), provider);
  const launcher = launcherOf(profiles[0]);
  const blocked = choice.multi ? !profiles.some((p) => launcherOf(p).ready) : !launcher.ready;
  return (
    <>
      <button type="button" {...choice.trigger}
        className={`wiz-pick wiz-backend-row${blocked ? ' needs-fix' : ''}${choice.multi ? ' has-accounts' : ''}`}
        title={choice.multi ? providerText.accountsLauncher(provider, profiles.length) : launcher.title}
        onClick={(e) => { if (!choice.takeClick(e)) onLaunch(profiles[0], launcher); }}>
        <span className="account-choice-anchor">
          {choice.multi && <AccountChoiceMark />}
          <AgentLogo kind={provider} size={20} />
        </span>
        <span className="wiz-pick-main">
          <span className="wiz-pick-name">{providerName(provider)}</span>
          {choice.multi
            ? <span className="wiz-pick-sub">{profiles.length} accounts</span>
            : !launcher.ready && <span className="wiz-pick-sub wiz-pick-blocked">⚠ {launcher.title}</span>}
        </span>
        <span className="wiz-pick-go">›</span>
      </button>
      <AccountChoiceMenu choice={choice} vps={vps} provider={provider} profiles={profiles} onPick={onLaunch} />
    </>
  );
}
