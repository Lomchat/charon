'use client';
import dynamic from '@/app/dynamic';
const CustomEndpointsSettings = dynamic(() => import('./CustomEndpointsSettings'), { ssr: false });
const UserCommandsSettings = dynamic(() => import('./UserCommandsSettings'), { ssr: false });
import Switch from './Switch';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { NOTIFICATION_EVENTS, normalizeChannelNotifications, type NotificationSession } from '@/lib/notificationPreferences';
import { NotificationTable } from './NotificationSettings';
import NotificationExceptions from './NotificationExceptions';
import SessionSettingsModal from './SessionSettingsModal';
import { useBrowserNotifications, saveBrowserNotifications } from './browserNotifications';
import type { Vps } from '@/lib/db/schema';
import ModelPicker from './ModelPicker';
import ModelReleaseNotice from './ModelReleaseNotice';
import type { AgentKind, ModelNoticesResponse } from '@/lib/types/api';
import CodexModelPicker from './CodexModelPicker';
import CursorModelPicker from './CursorModelPicker';
import { CursorDefaultRows } from './CursorEffortPicker';
import { pruneCursorEffort } from './cursorEffort';
import { catalogVpsFor } from './modelPickers';
import { MODE_LABELS, MODE_SWITCH_META, providerText } from '@/lib/providerText';
import AgentLogo from './AgentLogo';
import { IconArrowRepeat, IconBellFill, IconGear, IconPlug, IconSearch, IconTelegram, IconTerminal } from './icons';
import { Ladder, Segmented, SetCard, SetChip, SetHeader, SetRow } from './SettingsKit';
import { useClaudeEffortLevels, useCodexEffortLevels } from './effortOptions';
import { invalidateModels } from './modelsCache';
import {
  CLAUDE_PERMISSION_MODES, CODEX_SANDBOX_MODES, CURSOR_MODES, PROVIDERS,
  SESSION_PROVIDERS, defaultSessionMode, isSessionProvider, type SessionProvider,
} from '@/lib/sessionCapabilities';
import SettingSourcesPicker from './SettingSourcesPicker';
import {
  DEFAULT_SETTING_SOURCES, formatSettingSources, safeParseSettingSources,
} from '@/lib/settingSources';
import { THEMES, DEFAULT_THEME_ID } from './themes';
import { applyTheme, currentThemeId } from './themeClient';
import { applyDensity, currentDensity, DEFAULT_DENSITY, resolveDensity } from './density';
import { applyFileIcons, currentFileIcons, DEFAULT_FILE_ICONS, resolveFileIcons, type FileIconStyle } from './fileIconStyle';
import { FileIconSample } from './fileIcons';
import { useCodexSpeedChoices } from './codexModelsCache';
import { CLAUDE_FAST_HINT, codexSpeedRange } from '@/lib/speedCosts';


type Props = {
  onClose: () => void;
  /** Passed by HubPanel — used to source the per-VPS Codex catalog for the
   *  codex-defaults pickers (first codex-capable VPS wins). */
  vpsList?: Vps[];
  /** Section to open on. Used by the "enable one in Settings" link the wizard
   *  shows when both backends are switched off. */
  initialCat?: Cat;
  modelNotices: ModelNoticesResponse;
  onModelsSeen: (provider: AgentKind, ids: string[]) => Promise<void>;
};

// One nav entry per declared provider, DERIVED (§14.102): a new backend gets
// its own section, badge and green/red dot without a literal to update here.
// Its PANEL BODY stays bespoke — an empty one is visible, so it cannot be
// silently forgotten the way a missing list entry could.
type Cat = 'general' | SessionProvider | 'notifications' | 'updates' | 'endpoints' | 'commands';
const DENSITY_CHOICES = [
  { id: 'default', label: 'Default', hint: 'Comfortable spacing · 16px chat' },
  { id: 'small', label: 'Small', hint: 'More on screen · 14px chat' },
] as const;
const FILE_ICON_CHOICES: { id: FileIconStyle; label: string; hint: string }[] = [
  { id: 'colored', label: 'Colored', hint: 'A glyph per language, in its colour' },
  { id: 'mono', label: 'Mono', hint: 'The same glyphs, in the row’s colour' },
  { id: 'classic', label: 'Classic', hint: 'Generic shapes: code, text, image…' },
];
/** Deep-link target for `initialCat` (the wizard sends the user here when both
 *  backends are off). Exported so callers don't restate the union. */
export type SettingsCategory = Cat;

// The nav is grouped by THEME rather than one flat list: "what this hub looks
// like and how it reaches me" (hub), "the two backends" (agents), "keeping the
// fleet current" (maintenance). Five equal-weight entries read as a pile;
// three labelled groups read as a map.
const NAV_GROUPS: { id: string; label: string; cats: { id: Cat; label: string }[] }[] = [
  { id: 'hub', label: 'Hub', cats: [
    { id: 'general', label: 'General' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'endpoints', label: 'Custom endpoints' },
    { id: 'commands', label: 'Commands' },
  ] },
  { id: 'agents', label: 'Agents', cats: SESSION_PROVIDERS.map((p) => (
    { id: p, label: providerText.agentLabel(p) }
  )) },
  { id: 'maintenance', label: 'Maintenance', cats: [
    { id: 'updates', label: 'Updates' },
  ] },
];

/** What the nav search also matches, beyond each section's name. */
const NAV_KEYWORDS: Partial<Record<Cat, string>> = {
  general: 'theme display size density file icons ssh key public url',
  notifications: 'telegram browser sound events exceptions bot chat',
  endpoints: 'endpoint api server provider test model',
  commands: 'slash prompt command',
  updates: 'auto-update sdk version release',
  ...Object.fromEntries(SESSION_PROVIDERS.map((p) => [p, 'model effort speed fast mode default']) as [Cat, string][]),
  claude: 'model fallback effort speed fast ultracode recap mode settings files catalog api key',
  codex: 'model effort speed fast ultrafast mode approve reviewer',
  cursor: 'model effort speed fast thinking context mode usage',
};

const Toggle = Switch;

export default function SettingsModal({ onClose, vpsList, initialCat, modelNotices, onModelsSeen }: Props) {
  // Both display choices preview live. Closing without saving restores what
  // the server had rendered when the modal opened.
  const openedWith = useRef(currentThemeId());
  const openedDensity = useRef(currentDensity());
  const openedFileIcons = useRef(currentFileIcons());
  const close = useCallback(() => {
    applyTheme(openedWith.current);
    applyDensity(openedDensity.current);
    applyFileIcons(openedFileIcons.current);
    onClose();
  }, [onClose]);
  const [sessionSettings, setSessionSettings] = useState<NotificationSession | null>(null);
  const browserNotifications = useBrowserNotifications();
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  async function updateBrowser(value: typeof browserNotifications) {
    setBrowserBusy(true); setBrowserError(null);
    try { await saveBrowserNotifications(value); }
    catch (e) { setBrowserError(e instanceof Error ? e.message : String(e)); }
    finally { setBrowserBusy(false); }
  }
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [cat, setCat] = useState<Cat>(initialCat ?? 'general');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  // Every provider's discoveries are announced in `general` (the section the
  // header's dot opens on), so the nav badge sits there too.
  const hasNewModels = SESSION_PROVIDERS.some((p) => modelNotices[p].length > 0);

  // Both account-driven catalogs pick their box the same way — SIGNED IN
  // first, because an installed-but-signed-out VPS answers with an empty list
  // and the picker then looks like the provider has no models (§14.103).
  const cursorVps = useMemo(() => catalogVpsFor('cursor', vpsList), [vpsList]);
  const codexVps = useMemo(() => catalogVpsFor('codex', vpsList), [vpsList]);
  const codexSpeedChoices = useCodexSpeedChoices(codexVps?.id ?? null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !sessionSettings) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, sessionSettings]);

  useEffect(() => {
    api.getSettings().then((r) => setS(r)).catch(() => setS({}));
  }, []);

  function set(k: string, v: string) {
    setS((prev) => ({ ...(prev ?? {}), [k]: v }));
    setDirty((prev) => ({ ...prev, [k]: v }));
  }

  // A Cursor parameter set belongs to its model: a knob the new default does
  // not declare would fail every run of every session created from it
  // (§14.103), so the default effort follows the model, as in the header.
  const cursorModelPick = useRef(0);
  function setCursorDefaultModel(v: string) {
    set('cursor.default_model', v);
    const effort = s?.['cursor.default_effort'] ?? '';
    if (!cursorVps || !effort) return;
    const pick = ++cursorModelPick.current;
    void pruneCursorEffort(cursorVps.id, v, effort).then((kept) => {
      if (pick === cursorModelPick.current && (kept ?? '') !== effort) {
        set('cursor.default_effort', kept ?? '');
      }
    });
  }

  function acceptSavedDisplaySettings(resp: Record<string, string>) {
    openedWith.current = resp['app.theme'] ?? DEFAULT_THEME_ID;
    openedDensity.current = resolveDensity(resp['app.density']);
    openedFileIcons.current = resolveFileIcons(resp['app.file_icons']);
    applyTheme(openedWith.current);
    applyDensity(openedDensity.current);
    applyFileIcons(openedFileIcons.current);
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const resp: any = await api.updateSettings(dirty);
      const rejected: string[] | undefined = resp?.rejected;
      delete resp?.rejected;
      if (rejected?.includes('claude.api_key')) {
        // The server refused a non-sk-ant- key (browser autofilled the login
        // password into the type=password field). Clear it, keep the modal open.
        setS({ ...resp, 'claude.api_key': '' });
        alert('Anthropic API key not saved — it must start with "sk-ant-". A browser password-manager likely autofilled your login password here; retype the real key (or leave it blank).');
        return;
      }
      setS(resp);
      // The server's value, not the preview: it also covers a theme the route
      // refused, which must not stay on screen.
      acceptSavedDisplaySettings(resp);
      onClose();
    } catch (e: any) {
      alert('save: ' + (e?.message ?? e));
    } finally { setBusy(false); }
  }

  async function refreshModelList() {
    if (!s) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const saved: any = await api.updateSettings(dirty); // persist the key first
      acceptSavedDisplaySettings(saved);
      if (saved?.rejected?.includes('claude.api_key')) {
        setSyncMsg({ ok: false, msg: 'key rejected — it must start with "sk-ant-". A browser autofill likely replaced it with your login password; retype the real Anthropic key.' });
        return;
      }
      const r = await api.refreshClaudeModels();
      if (r.ok) {
        invalidateModels();
        setCatalogRefresh((n) => n + 1);
        setSyncMsg({ ok: true, msg: `synced ✓ — ${r.count ?? 0} models` });
      } else {
        setSyncMsg({ ok: false, msg: r.error || 'sync failed' });
      }
    } catch (e: any) {
      setSyncMsg({ ok: false, msg: e?.message ?? String(e) });
    } finally { setSyncing(false); }
  }

  async function testTelegram() {
    if (!s) return;
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await api.updateSettings(dirty); // persist first, then test
      acceptSavedDisplaySettings(saved);
      await api.testTelegram();
      setTestResult({ ok: true, msg: 'test message sent ✓ — check Telegram' });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message ?? String(e) });
    } finally { setTesting(false); }
  }

  const navIcon = (id: Cat) => {
    if (isSessionProvider(id)) return <AgentLogo kind={id} size={15} />;
    if (id === 'general') return <span className="nav-ico"><IconGear /></span>;
    if (id === 'notifications') return <span className="nav-ico"><IconBellFill /></span>;
    if (id === 'endpoints') return <span className="nav-ico"><IconPlug /></span>;
    if (id === 'commands') return <span className="nav-ico"><IconTerminal /></span>;
    return <span className="nav-ico"><IconArrowRepeat /></span>;
  };

  // The backend switches, read the same way everywhere: anything but the
  // literal 'false' is ON (app/enabledBackends.ts). The nav carries the state
  // as a green/red dot so "why is there no ＋ Codex button" is answered without
  // opening the section.
  const backendOn = (kind: AgentKind) => s?.[`${kind}.enabled`] !== 'false';
  const availability = (kind: SessionProvider) => (
    <span className="st-avail" title={providerText.backendAvailable(kind)}>
      <span>Available</span>
      <Toggle
        checked={backendOn(kind)}
        onChange={(v) => set(`${kind}.enabled`, v ? 'true' : 'false')}
        label={`offer ${providerText.agentLabel(kind)} sessions in this hub`}
      />
    </span>
  );

  // The same Mode row for every agent: its modes side by side, tinted by risk.
  const modeRow = (kind: SessionProvider, key: string, modes: readonly string[], fallback: string, hint?: string) => (
    <SetRow label="Mode" hint={hint}>
      <Segmented label="Mode" value={s?.[key] || fallback} onChange={(v) => set(key, v)}
        options={modes.map((m) => ({
          id: m, label: MODE_SWITCH_META[m]?.label ?? MODE_LABELS[m] ?? m,
          title: MODE_SWITCH_META[m]?.title ?? MODE_LABELS[m], tone: MODE_SWITCH_META[m]?.risk,
        }))} />
    </SetRow>
  );

  // A provider's released versions, as its header says them.
  const versionsOf = (kind: SessionProvider) => PROVIDERS[kind].backend.versions
    .map((line) => (s?.[line.latestSettingKey] ? `${line.packageLabel} ${s[line.latestSettingKey]}` : line.packageLabel))
    .join(' · ');

  const agentHeader = (kind: SessionProvider, catalogVps?: Vps | null) => (
    <SetHeader icon={<AgentLogo kind={kind} size={22} />} title={providerText.agentLabel(kind)}
      sub={<span className="st-mono">{versionsOf(kind)}</span>}
      chips={catalogVps ? <SetChip title="The account catalog these pickers read">catalog via {catalogVps.name}</SetChip> : undefined}
      right={availability(kind)} />
  );

  const usageCard = (kind: SessionProvider) => PROVIDERS[kind].usageDashboardUrl && (
    <SetCard title="Account usage">
      <SetRow label="Usage" hint={providerText.usageOnWebOnly(kind)}>
        <a className="st-link" href={PROVIDERS[kind].usageDashboardUrl!} target="_blank" rel="noopener noreferrer">
          {providerText.usageOpenDashboard(kind)} ↗
        </a>
      </SetRow>
    </SetCard>
  );

  const claudeEfforts = useClaudeEffortLevels(s?.['claude.default_model'] ?? '', s?.['claude.default_effort'] ?? '');
  const codexEfforts = useCodexEffortLevels(codexVps?.id ?? '', s?.['codex.default_model'] ?? '', s?.['codex.default_effort'] ?? '');
  const [navQuery, setNavQuery] = useState('');
  const navMatch = (c: { id: Cat; label: string }) => {
    const q = navQuery.trim().toLowerCase();
    return !q || `${c.label} ${NAV_KEYWORDS[c.id] ?? ''}`.toLowerCase().includes(q);
  };
  const unsaved = Object.keys(dirty).length;
  const claudeCatalog = `${catalogRefresh}:${modelNotices.claude.map((m) => m.id).join(',')}`;

  return (
    <>
    <div style={sessionSettings ? { display: 'none' } : undefined} className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="app-modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <button className="modal-close" onClick={close} aria-label="Close settings" title="Close settings">✕</button>
        {s == null && <div className="empty">loading…</div>}
        {s && (
          <>
            <div className="settings-body">
              <nav className="settings-nav" aria-label="settings sections">
                <div className="st-nav-head">
                  <span className="st-nav-title"><IconGear />Settings</span>
                  <span className="st-nav-search">
                    <IconSearch />
                    <input value={navQuery} onChange={(e) => setNavQuery(e.target.value)} placeholder="Search settings"
                      aria-label="Search settings" spellCheck={false}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        const hit = NAV_GROUPS.flatMap((g) => g.cats).find(navMatch);
                        if (hit) setCat(hit.id);
                      }} />
                  </span>
                </div>
                {NAV_GROUPS.map((g) => {
                  const cats = g.cats.filter(navMatch);
                  if (!cats.length) return null;
                  return (
                    <div key={g.id} className="settings-nav-group">
                      <div className="settings-nav-group-label">{g.label}</div>
                      {cats.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={cat === c.id ? 'on' : ''}
                          onClick={() => setCat(c.id)}
                        >
                          {navIcon(c.id)}
                          <span>{c.label}</span>
                          {c.id === 'general' && hasNewModels && (
                            <span className="model-notice-badge" aria-label="new models available">new</span>
                          )}
                          {isSessionProvider(c.id) && (
                            <span
                              className={`nav-state${backendOn(c.id) ? ' on' : ' off'}`}
                              title={backendOn(c.id) ? `${c.label} is available` : `${c.label} is switched off`}
                              aria-label={backendOn(c.id) ? `${c.label} enabled` : `${c.label} disabled`}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </nav>

              <div className="settings-pane">
                {cat === 'endpoints' && <CustomEndpointsSettings vpsList={vpsList} />}
                {cat === 'commands' && <UserCommandsSettings />}
                {cat === 'general' && (() => {
                  const themeId = s['app.theme'] ?? DEFAULT_THEME_ID;
                  const density = s['app.density'] ?? DEFAULT_DENSITY;
                  const icons = resolveFileIcons(s['app.file_icons'] ?? DEFAULT_FILE_ICONS);
                  return (
                  <>
                    <SetHeader icon={<IconGear />} title="General" sub="How this hub looks, and how it is reached."
                      chips={<>
                        <SetChip>{THEMES.find((t) => t.id === themeId)?.label ?? themeId}</SetChip>
                        <SetChip>{DENSITY_CHOICES.find((d) => d.id === density)?.label ?? density} display</SetChip>
                        <SetChip>{FILE_ICON_CHOICES.find((f) => f.id === icons)?.label} icons</SetChip>
                      </>} />
                    <ModelReleaseNotice notices={modelNotices} onSeen={onModelsSeen} />
                    <SetCard title="Theme" aside="The whole hub, every device · previewed live">
                      <div className="st-themes" role="radiogroup" aria-label="Theme">
                        {THEMES.map((theme) => (
                          <button key={theme.id} type="button" role="radio" aria-checked={themeId === theme.id}
                            className={`st-theme${themeId === theme.id ? ' on' : ''}`} title={theme.hint}
                            onClick={() => { set('app.theme', theme.id); applyTheme(theme.id); }}>
                            <span className="st-theme-pv" data-theme={theme.id} aria-hidden="true"><i /><i /><i /></span>
                            <span>{theme.label}</span>
                          </button>
                        ))}
                      </div>
                    </SetCard>
                    <SetCard title="Display size" aside="Previewed live">
                      <div className="fi-choice-grid">
                        {DENSITY_CHOICES.map((choice) => (
                          <label
                            key={choice.id}
                            className="density-choice"
                            data-size={choice.id}
                            data-selected={density === choice.id}
                          >
                            <input
                              type="radio"
                              name="app.density"
                              value={choice.id}
                              checked={density === choice.id}
                              onChange={() => { set('app.density', choice.id); applyDensity(choice.id); }}
                            />
                            <span className="density-preview" aria-hidden="true">
                              <span className="density-preview-rows"><i /><i /><i /></span>
                              <span className="density-preview-text">Show me the result.</span>
                            </span>
                            <span className="density-choice-title">
                              <span>{choice.label}</span>
                              <span className="density-choice-check" aria-hidden="true">✓</span>
                            </span>
                            <span className="density-choice-hint">{choice.hint}</span>
                          </label>
                        ))}
                      </div>
                    </SetCard>
                    <SetCard title="File icons" aside="Explorer, tabs and search">
                      <div className="fi-choice-grid">
                        {FILE_ICON_CHOICES.map((choice) => {
                          const on = icons === choice.id;
                          return (
                            <label key={choice.id} className="density-choice fi-choice" data-selected={on}>
                              <input
                                type="radio"
                                name="app.file_icons"
                                value={choice.id}
                                checked={on}
                                onChange={() => { set('app.file_icons', choice.id); applyFileIcons(choice.id); }}
                              />
                              <span className="fi-choice-sample" aria-hidden="true">
                                <FileIconSample style={choice.id} />
                              </span>
                              <span className="density-choice-title">
                                <span>{choice.label}</span>
                                <span className="density-choice-check" aria-hidden="true">✓</span>
                              </span>
                              <span className="density-choice-hint">{choice.hint}</span>
                            </label>
                          );
                        })}
                      </div>
                    </SetCard>
                    <SetCard title="Connection">
                      <SetRow label="SSH key" hint="Path on the hub server">
                        <input className="st-input st-mono" aria-label="SSH key path" value={s['ssh.private_key_path'] ?? ''}
                          onChange={(e) => set('ssh.private_key_path', e.target.value)} placeholder="/root/.ssh/id_rsa" />
                      </SetRow>
                      <SetRow label="Public URL" hint="Deep links in Telegram and push">
                        <input className="st-input st-mono" aria-label="Public URL of this hub" value={s['app.public_url'] ?? ''}
                          onChange={(e) => set('app.public_url', e.target.value)} placeholder="https://charon.example.com"
                          type="url" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                      </SetRow>
                    </SetCard>
                  </>
                  );
                })()}

                {cat === 'claude' && (() => {
                  const fast = s['claude.default_fast_mode'] === 'true';
                  return (
                  <>
                    {agentHeader('claude')}
                    <SetCard title="New sessions start with">
                      <SetRow label="Model">
                        <ModelPicker catalogVersion={claudeCatalog} value={s['claude.default_model'] ?? ''}
                          onChange={(v) => set('claude.default_model', v)} inheritPlaceholder="SDK default" />
                      </SetRow>
                      <SetRow label="Fallback" hint="When the model is rate-limited">
                        <ModelPicker catalogVersion={claudeCatalog} value={s['claude.default_fallback_model'] ?? ''}
                          onChange={(v) => set('claude.default_fallback_model', v)} inheritPlaceholder="none" />
                      </SetRow>
                      <SetRow label="Effort">
                        <Ladder label="Effort" inheritLabel="default" value={s['claude.default_effort'] ?? ''}
                          options={claudeEfforts.map((e) => ({ id: e, label: e }))}
                          onChange={(v) => set('claude.default_effort', v)} />
                      </SetRow>
                      <SetRow label="Speed" note={fast ? CLAUDE_FAST_HINT : undefined}>
                        <Segmented label="Speed" value={fast ? 'fast' : 'standard'}
                          onChange={(v) => set('claude.default_fast_mode', v === 'fast' ? 'true' : '')}
                          options={[
                            { id: 'standard', label: 'Standard', title: 'Normal speed · normal price' },
                            { id: 'fast', label: 'Fast', tone: 'info', title: `${CLAUDE_FAST_HINT}, where the model and plan allow it` },
                          ]} />
                      </SetRow>
                      <SetRow label="Ultracode" hint="Big tasks as parallel workflows">
                        <Toggle checked={s['claude.default_ultracode'] === 'true'} tone="violet" size="sm"
                          onChange={(v) => set('claude.default_ultracode', v ? 'true' : '')} label="Ultracode by default" />
                      </SetRow>
                      {modeRow('claude', 'claude.default_permission_mode', CLAUDE_PERMISSION_MODES, 'normal')}
                    </SetCard>
                    <SetCard title="Behaviour">
                      <SetRow label="Recap" hint="A line under each answer">
                        <Toggle checked={s['claude.auto_recap'] !== 'false'} size="sm"
                          onChange={(v) => set('claude.auto_recap', v ? '' : 'false')} label="Recap after each turn" />
                      </SetRow>
                      {/* §14.100 — the bottom of the chain, so no "inherit"
                          option here: this IS what a VPS and a session inherit.
                          A VPS overrides it from its card in the data modal. */}
                      <SetRow label="Settings files" hint="Read when a session starts">
                        <SettingSourcesPicker
                          value={safeParseSettingSources(s['claude.setting_sources']) ?? [...DEFAULT_SETTING_SOURCES]}
                          // `next` is never null without an `inherited` prop; the
                          // fallback keeps the fleet default from ever becoming ''.
                          onChange={(next) => set('claude.setting_sources',
                            formatSettingSources(next ?? DEFAULT_SETTING_SOURCES))}
                        />
                      </SetRow>
                    </SetCard>
                    <SetCard title="Model catalog">
                      <SetRow label="API key" hint="Catalog sync only, never inference">
                        {/* PLAIN TEXT on purpose (NOT type=password): Chrome's
                            password manager only autofills the SITE login password
                            into type=password fields (ignoring autocomplete=off),
                            which overwrote the real key. type=text + a
                            non-credential name keep autofill away. The GET returns
                            only a start+end preview (`sk-ant-api…wXYZ`), never the
                            secret middle; leaving it untouched round-trips as
                            "unchanged" (the route keeps the stored key), and any
                            non-sk-ant- value is rejected. */}
                        <input
                          className="st-input st-mono"
                          aria-label="Anthropic API key"
                          value={s['claude.api_key'] ?? ''}
                          onChange={(e) => set('claude.api_key', e.target.value)}
                          placeholder="sk-ant-…"
                          type="text"
                          name="charon-anthropic-catalog-key"
                          autoComplete="off"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-bwignore="true"
                          data-form-type="other"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                        />
                        <button type="button" className="st-btn" onClick={refreshModelList} disabled={syncing || !s['claude.api_key']}>
                          <IconArrowRepeat />{syncing ? 'Syncing…' : 'Refresh'}
                        </button>
                      </SetRow>
                      {(s['claude.models_cache_at'] || syncMsg) && (
                        <p className={`st-foot-note${syncMsg ? (syncMsg.ok ? ' ok' : ' err') : ''}`}>
                          {syncMsg ? syncMsg.msg : `Last sync ${new Date(Number(s['claude.models_cache_at'])).toLocaleString()}`}
                        </p>
                      )}
                    </SetCard>
                    {usageCard('claude')}
                  </>
                  );
                })()}

                {cat === 'codex' && (() => {
                  const tier = s['codex.default_service_tier'] ?? '';
                  return (
                  <>
                    {agentHeader('codex', codexVps)}
                    <SetCard title="New sessions start with">
                      {codexVps ? <>
                        <SetRow label="Model">
                          <CodexModelPicker catalogVersion={modelNotices.codex.map((m) => m.id).join(',')} vpsId={codexVps.id}
                            value={s['codex.default_model'] ?? ''} onChange={(v) => set('codex.default_model', v)}
                            inheritPlaceholder={`${providerText.agentLabel('codex')} default`} />
                        </SetRow>
                        <SetRow label="Effort">
                          <Ladder label="Effort" inheritLabel="default" value={s['codex.default_effort'] ?? ''}
                            options={codexEfforts.map((e) => ({ id: e, label: e }))}
                            onChange={(v) => set('codex.default_effort', v)} />
                        </SetRow>
                        {codexSpeedChoices && (
                          <SetRow label="Speed" note={tier ? `${codexSpeedRange(tier) ?? ''}${codexSpeedRange(tier) ? ' · ' : ''}standard where the model lacks it` : undefined}>
                            <Segmented label="Speed" value={tier} onChange={(v) => set('codex.default_service_tier', v)}
                              options={[
                                { id: '', label: 'Standard', title: 'Normal speed · normal usage' },
                                ...codexSpeedChoices.map((t) => ({ id: t.id, label: t.name, tone: 'info' as const, title: codexSpeedRange(t.id) ?? undefined })),
                              ]} />
                          </SetRow>
                        )}
                      </> : <>
                        <SetRow label="Model" hint="No catalog yet: no signed-in VPS">
                          <input className="st-input st-mono" aria-label="Default model" value={s['codex.default_model'] ?? ''}
                            onChange={(e) => set('codex.default_model', e.target.value)} placeholder="gpt-5.6-sol" autoComplete="off" spellCheck={false} />
                        </SetRow>
                        <SetRow label="Effort">
                          <input className="st-input st-mono" aria-label="Default effort" value={s['codex.default_effort'] ?? ''}
                            onChange={(e) => set('codex.default_effort', e.target.value)} placeholder="medium" autoComplete="off" spellCheck={false} />
                        </SetRow>
                      </>}
                      {modeRow('codex', 'codex.default_permission_mode', CODEX_SANDBOX_MODES, 'workspace-write')}
                    </SetCard>
                    <SetCard title="Behaviour">
                      <SetRow label="Approve for me" hint="Its reviewer answers requests">
                        <Toggle checked={(s['codex.default_approvals_reviewer'] ?? 'auto_review') === 'auto_review'} size="sm"
                          onChange={(v) => set('codex.default_approvals_reviewer', v ? 'auto_review' : 'user')}
                          label={providerText.autoReviewDefault('codex')} />
                      </SetRow>
                    </SetCard>
                    {usageCard('codex')}
                  </>
                  );
                })()}

                {cat === 'cursor' && (
                  <>
                    {agentHeader('cursor', cursorVps)}
                    <SetCard title="New sessions start with">
                      <SetRow label="Model" hint={cursorVps ? undefined : 'No catalog yet: no signed-in VPS'}>
                        {cursorVps
                          ? <CursorModelPicker catalogVersion={modelNotices.cursor.map((m) => m.id).join(',')} vpsId={cursorVps.id}
                              value={s['cursor.default_model'] ?? ''} onChange={setCursorDefaultModel}
                              inheritPlaceholder={`${providerText.agentLabel('cursor')} default`} />
                          : <input className="st-input st-mono" aria-label="Default model" value={s['cursor.default_model'] ?? ''}
                              onChange={(e) => set('cursor.default_model', e.target.value)} placeholder="default" autoComplete="off" spellCheck={false} />}
                      </SetRow>
                      {cursorVps && (
                        <CursorDefaultRows vpsId={cursorVps.id} modelId={s['cursor.default_model'] ?? ''}
                          value={s['cursor.default_effort'] ?? ''} onChange={(v) => set('cursor.default_effort', v)} />
                      )}
                      {modeRow('cursor', 'cursor.default_permission_mode', CURSOR_MODES, defaultSessionMode('cursor'),
                        'No per-request approval: the mode is the whole gate')}
                    </SetCard>
                    {usageCard('cursor')}
                  </>
                )}

                {cat === 'notifications' && (
                  <div className="notification-settings">
                    <SetHeader icon={<IconBellFill />} title="Notifications" sub="What reaches you, and where."
                      chips={<>
                        <SetChip tone={browserNotifications.enabled ? 'ok' : 'off'}>Browser {browserNotifications.enabled ? 'on' : 'off'}</SetChip>
                        <SetChip tone={s['telegram.enabled'] === 'true' ? 'ok' : 'off'}>Telegram {s['telegram.enabled'] === 'true' ? 'on' : 'off'}</SetChip>
                      </>} />
                    <SetCard className="st-card-table">
                      <NotificationTable
                        browser={{ value: browserNotifications, busy: browserBusy,
                          onChange: (value) => void updateBrowser({ ...browserNotifications, ...value }) }}
                        telegram={{ value: normalizeChannelNotifications({ enabled: s['telegram.enabled'] === 'true', events: Object.fromEntries(NOTIFICATION_EVENTS.map(({ id }) => [id, (s[`telegram.notify.${id}`] ?? 'true') === 'true'])) }),
                          onChange: (value) => {
                            if (value.enabled !== (s['telegram.enabled'] === 'true')) set('telegram.enabled', String(value.enabled));
                            for (const { id } of NOTIFICATION_EVENTS) {
                              if (value.events[id] !== ((s[`telegram.notify.${id}`] ?? 'true') === 'true')) set(`telegram.notify.${id}`, String(value.events[id]));
                            }
                          } }} />
                    </SetCard>
                    <p className="st-foot-note">Browser changes save at once; Telegram ones on Save.</p>
                    {browserError && <p className="notification-error" role="alert">{browserError}</p>}
                    <details className="st-card st-details">
                      <summary><span className="st-card-title"><IconTelegram />Telegram connection</span><span aria-hidden="true">›</span></summary>
                      <p className="st-foot-note">Reply to permission requests and questions from Telegram. Create a bot with <code>@BotFather</code>.</p>
                      <SetRow label="Bot token">
                        <input className="st-input st-mono" aria-label="Telegram bot token" value={s['telegram.bot_token'] ?? ''}
                          onChange={(e) => set('telegram.bot_token', e.target.value)} placeholder="123456:ABC-…" type="text"
                          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                      </SetRow>
                      <SetRow label="Chat id">
                        <input className="st-input st-mono" aria-label="Telegram chat id" value={s['telegram.chat_id'] ?? ''}
                          onChange={(e) => set('telegram.chat_id', e.target.value)} placeholder="123456789" inputMode="numeric" />
                        <button type="button" className="st-btn" onClick={testTelegram}
                          disabled={testing || s['telegram.enabled'] !== 'true' || !s['telegram.bot_token'] || !s['telegram.chat_id']}>
                          {testing ? 'Sending…' : 'Test'}
                        </button>
                      </SetRow>
                      {testResult && <p className={`st-foot-note ${testResult.ok ? 'ok' : 'err'}`}>{testResult.msg}</p>}
                    </details>
                    <div className="st-card st-card-flush"><NotificationExceptions onOpen={setSessionSettings} /></div>
                  </div>
                )}

                {cat === 'updates' && (
                  <>
                    <SetHeader icon={<IconArrowRepeat />} title="Updates" sub="Agents update themselves when a VPS is idle." />
                    {/* One row per DECLARED backend, and the packages it names
                        come from its own registry entry (§14.102). Hand-written,
                        this block had two rows for three backends — and the
                        third's gate defaults ON, so an opt-in backend nobody
                        had enabled was sleeping and resuming every session on
                        every quiet VPS at each of its releases. */}
                    <SetCard title="Auto-update when a VPS is idle">
                      {SESSION_PROVIDERS.map((p) => {
                        const key = PROVIDERS[p].settings.autoUpdateKey;
                        return (
                          <SetRow key={p} label={providerText.agentLabel(p)}
                            hint={PROVIDERS[p].backend.versions.map((line) => line.packageLabel).join(' + ')}>
                            <Toggle
                              checked={(s[key] ?? 'true') === 'true'} size="sm"
                              onChange={(v) => set(key, v ? 'true' : 'false')}
                              label={`auto-update ${providerText.agentLabel(p)} when a VPS is idle`}
                            />
                          </SetRow>
                        );
                      })}
                    </SetCard>
                    {(() => {
                      // `latest` per DECLARED release line, read from the
                      // settings map by the key the registry names for it.
                      const lines = SESSION_PROVIDERS.flatMap((p) => PROVIDERS[p].backend.versions)
                        .map((line) => ({ label: line.packageLabel, value: s[line.latestSettingKey] }))
                        .filter((x) => !!x.value);
                      if (!lines.length) return null;
                      return (
                        <SetCard title="Latest releases">
                          {lines.map((x) => (
                            <SetRow key={x.label} label={x.label}><span className="st-mono st-strong">{x.value}</span></SetRow>
                          ))}
                        </SetCard>
                      );
                    })()}
                  </>
                )}
              </div>
            </div>

            <div className="settings-foot st-foot">
              {(cat === 'endpoints' || cat === 'commands') && !unsaved
                ? <>
                    <span className="st-unsaved clean"><i />{cat === 'commands' ? 'Commands are saved individually' : 'Connections are saved individually'}</span>
                    <button type="button" className="st-btn primary" onClick={close}>Done</button>
                  </>
                : <>
                    <span className={`st-unsaved${unsaved ? '' : ' clean'}`}><i />{unsaved ? `${unsaved} unsaved change${unsaved > 1 ? 's' : ''}` : 'No changes'}</span>
                    <button type="button" className="st-btn" onClick={close}>Cancel</button>
                    <button type="button" className="st-btn primary" onClick={save} disabled={busy}>Save</button>
                  </>}
            </div>
          </>
        )}
      </div>
    </div>
    {sessionSettings && <SessionSettingsModal session={sessionSettings} onClose={() => setSessionSettings(null)} />}
    </>
  );
}
