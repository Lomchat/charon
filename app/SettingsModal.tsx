'use client';
import PickerControl from './PickerControl';
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
import EffortPicker from './EffortPicker';
import CodexModelPicker from './CodexModelPicker';
import CodexEffortPicker from './CodexEffortPicker';
import AgentLogo from './AgentLogo';
import { invalidateModels } from './modelsCache';
import { CLAUDE_PERMISSION_MODES, CODEX_SANDBOX_MODES } from '@/lib/sessionCapabilities';
import SettingSourcesPicker from './SettingSourcesPicker';
import {
  DEFAULT_SETTING_SOURCES, formatSettingSources, safeParseSettingSources,
} from '@/lib/settingSources';
import { THEMES, DEFAULT_THEME_ID } from './themes';
import { applyTheme, currentThemeId } from './themeClient';

const MODE_LABEL: Record<string, string> = {
  normal: 'normal — ask before tools',
  acceptEdits: 'accept edits — edits without asking',
  auto: 'accept all — never ask',
  plan: 'plan mode — read and plan',
  'read-only': 'read only — no writes',
  'workspace-write': 'workspace — write inside the project',
  'full-access': 'full access — unrestricted sandbox, approvals remain',
  'accept-all': 'accept all — unrestricted and never ask',
};

type Props = {
  onClose: () => void;
  /** Passed by ClaudePanel — used to source the per-VPS Codex catalog for the
   *  codex-defaults pickers (first codex-capable VPS wins). */
  vpsList?: Vps[];
  /** Section to open on. Used by the "enable one in Settings" link the wizard
   *  shows when both backends are switched off. */
  initialCat?: Cat;
  modelNotices: ModelNoticesResponse;
  onModelsSeen: (provider: AgentKind, ids: string[]) => Promise<void>;
};

type Cat = 'general' | 'claude' | 'codex' | 'notifications' | 'updates';
/** Deep-link target for `initialCat` (the wizard sends the user here when both
 *  backends are off). Exported so callers don't restate the union. */
export type SettingsCategory = Cat;

// The nav is grouped by THEME rather than one flat list: "what this hub looks
// like and how it reaches me" (hub), "the two backends" (agents), "keeping the
// fleet current" (maintenance). Five equal-weight entries read as a pile;
// three labelled groups read as a map.
const NAV_GROUPS: { id: string; label: string; cats: { id: Cat; label: string }[] }[] = [
  { id: 'hub', label: 'hub', cats: [
    { id: 'general', label: 'general' },
    { id: 'notifications', label: 'notifications' },
  ] },
  { id: 'agents', label: 'agents', cats: [
    { id: 'claude', label: 'claude' },
    { id: 'codex', label: 'codex' },
  ] },
  { id: 'maintenance', label: 'maintenance', cats: [
    { id: 'updates', label: 'updates' },
  ] },
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

export default function SettingsModal({ onClose, vpsList, initialCat, modelNotices, onModelsSeen }: Props) {
  // The theme picker previews LIVE (a swatch cannot tell you whether a theme is
  // comfortable), so the modal owns an undo: everything that closes without
  // saving restores the theme in effect when it opened.
  const openedWith = useRef(currentThemeId());
  const close = useCallback(() => { applyTheme(openedWith.current); onClose(); }, [onClose]);
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

  // The Codex catalog is per-VPS (account-driven). Use the first connected
  // codex-capable VPS; fall back to any codex-capable one.
  const codexVps = useMemo(() => {
    const list = vpsList ?? [];
    return (
      list.find((v) => v.codexAvailable === 1 && v.agentStatus === 'ok') ??
      list.find((v) => v.codexAvailable === 1) ??
      null
    );
  }, [vpsList]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !sessionSettings) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, sessionSettings]);

  useEffect(() => {
    api.getClaudeSettings().then((r) => setS(r)).catch(() => setS({}));
  }, []);

  function set(k: string, v: string) {
    setS((prev) => ({ ...(prev ?? {}), [k]: v }));
    setDirty((prev) => ({ ...prev, [k]: v }));
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const resp: any = await api.updateClaudeSettings(dirty);
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
      openedWith.current = resp['app.theme'] ?? DEFAULT_THEME_ID;
      applyTheme(openedWith.current);
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
      const saved: any = await api.updateClaudeSettings(dirty); // persist the key first
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
      await api.updateClaudeSettings(dirty); // persist first, then test
      await api.testTelegram();
      setTestResult({ ok: true, msg: 'test message sent ✓ — check Telegram' });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message ?? String(e) });
    } finally { setTesting(false); }
  }

  const navIcon = (id: Cat) => {
    if (id === 'claude') return <AgentLogo kind="claude" size={14} />;
    if (id === 'codex') return <AgentLogo kind="codex" size={14} />;
    if (id === 'general') return <span className="nav-ico">⚙</span>;
    if (id === 'notifications') return <span className="nav-ico">✉</span>;
    return <span className="nav-ico">↻</span>;
  };

  // The backend switches, read the same way everywhere: anything but the
  // literal 'false' is ON (app/enabledBackends.ts). The nav carries the state
  // as a green/red dot so "why is there no ＋ Codex button" is answered without
  // opening the section.
  const backendOn = (kind: AgentKind) => s?.[`${kind}.enabled`] !== 'false';
  const backendSwitch = (kind: AgentKind, label: string) => (
    <>
      <div className="switch-row">
        <span>{label} available in this hub</span>
        <Toggle
          checked={backendOn(kind)}
          onChange={(v) => set(`${kind}.enabled`, v ? 'true' : 'false')}
          label={`offer ${label} sessions in this hub`}
        />
      </div>
      <p className="set-meta">
        Off hides every {label} launcher — the ＋ button on each VPS, the one in
        the tab bar, and its row in the new-session wizard. Existing {label}{' '}
        sessions keep running and stay in the sidebar.
      </p>
    </>
  );

  return (
    <>
    <div style={sessionSettings ? { display: 'none' } : undefined} className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="claude-modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <button className="modal-close" onClick={close} aria-label="Close settings" title="Close settings">✕</button>
        <h2>settings</h2>
        {s == null && <div className="empty">loading…</div>}
        {s && (
          <>
            <div className="settings-body">
              <nav className="settings-nav" aria-label="settings sections">
                {NAV_GROUPS.map((g) => (
                  <div key={g.id} className="settings-nav-group">
                    <div className="settings-nav-group-label">{g.label}</div>
                    {g.cats.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={cat === c.id ? 'on' : ''}
                        onClick={() => setCat(c.id)}
                      >
                        {navIcon(c.id)}
                        <span>{c.label}</span>
                        {(c.id === 'claude' || c.id === 'codex') && modelNotices[c.id].length > 0 && (
                          <span className="model-notice-badge" aria-label="new models available">new</span>
                        )}
                        {(c.id === 'claude' || c.id === 'codex') && (
                          <span
                            className={`nav-state${backendOn(c.id) ? ' on' : ' off'}`}
                            title={backendOn(c.id) ? `${c.label} is available` : `${c.label} is switched off`}
                            aria-label={backendOn(c.id) ? `${c.label} enabled` : `${c.label} disabled`}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </nav>

              <div className="settings-pane">
                {cat === 'general' && (
                  <>
                    <label>theme
                      <PickerControl
                        value={s['app.theme'] ?? DEFAULT_THEME_ID}
                        onValueChange={(nextValue) => { set('app.theme', nextValue); applyTheme(nextValue); }}
                      >
                        {THEMES.map((theme) => (
                          <option key={theme.id} value={theme.id}>{theme.label} — {theme.hint}</option>
                        ))}
                      </PickerControl>
                    </label>
                    <p className="set-meta">
                      Applies to the whole hub, on every device. Previewed as you
                      pick; cancel puts the previous one back.
                    </p>
                    <label>SSH key (path on the hub server)
                      <input value={s['ssh.private_key_path'] ?? ''} onChange={(e) => set('ssh.private_key_path', e.target.value)} placeholder="/root/.ssh/id_rsa" />
                    </label>
                    <label>public URL of this hub (deep links in Telegram / push)
                      <input value={s['app.public_url'] ?? ''} onChange={(e) => set('app.public_url', e.target.value)} placeholder="https://charon.example.com" type="url" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                    </label>
                  </>
                )}

                {cat === 'claude' && (
                  <>
                    {backendSwitch('claude', 'Claude')}
                    <div className="settings-sub">new session defaults</div>
                    <p className="set-hint">defaults for new Claude sessions — blank = SDK default.</p>
                    <label>default model
                      <ModelPicker
                        catalogVersion={`${catalogRefresh}:${modelNotices.claude.map((m) => m.id).join(",")}`}
                        value={s['claude.default_model'] ?? ''}
                        onChange={(v) => set('claude.default_model', v)}
                        inheritPlaceholder="SDK default"
                      />
                      <ModelReleaseNotice key="claude" provider="claude" unread={modelNotices.claude} onSeen={onModelsSeen} />
                    </label>
                    <label>default fallback model (when the primary is rate-limited)
                      <ModelPicker
                        catalogVersion={`${catalogRefresh}:${modelNotices.claude.map((m) => m.id).join(",")}`}
                        value={s['claude.default_fallback_model'] ?? ''}
                        onChange={(v) => set('claude.default_fallback_model', v)}
                        inheritPlaceholder="none"
                      />
                    </label>
                    <label>default effort
                      <EffortPicker
                        value={s['claude.default_effort'] ?? ''}
                        onChange={(v) => set('claude.default_effort', v)}
                        inheritPlaceholder="SDK default"
                      />
                    </label>
                    <label>default mode
                      <PickerControl
                        value={s['claude.default_permission_mode'] ?? 'normal'}
                        onValueChange={(nextValue) => set('claude.default_permission_mode', nextValue)}
                      >
                        {CLAUDE_PERMISSION_MODES.map((mode) => (
                          <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>
                        ))}
                      </PickerControl>
                    </label>

                    {/* §14.100 — the bottom of the chain, so no "inherit"
                        option here: this IS what a VPS and a session inherit.
                        A VPS overrides it from its card in the data modal. */}
                    <div className="settings-sub">settings files sessions load</div>
                    <SettingSourcesPicker
                      value={safeParseSettingSources(s['claude.setting_sources']) ?? [...DEFAULT_SETTING_SOURCES]}
                      // `next` is never null without an `inherited` prop; the
                      // fallback keeps the fleet default from ever becoming ''.
                      onChange={(next) => set('claude.setting_sources',
                        formatSettingSources(next ?? DEFAULT_SETTING_SOURCES))}
                    />

                    <div className="settings-sub">model catalog</div>
                    <label>Anthropic API key (catalog sync only — never inference)
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
                    </label>
                    <div className="tg-test-row">
                      <button type="button" onClick={refreshModelList} disabled={syncing || !s['claude.api_key']}>
                        {syncing ? 'syncing…' : '↻ refresh model list'}
                      </button>
                      {s['claude.models_cache_at'] && (
                        <span className="set-meta" style={{ marginLeft: 8 }}>
                          last sync: {new Date(Number(s['claude.models_cache_at'])).toLocaleString()}
                        </span>
                      )}
                      {syncMsg && (
                        <span className={`tg-result ${syncMsg.ok ? 'ok' : 'err'}`}>{syncMsg.msg}</span>
                      )}
                    </div>
                  </>
                )}

                {cat === 'codex' && (
                  <>
                    {backendSwitch('codex', 'Codex')}
                    <div className="settings-sub">new session defaults</div>
                    <p className="set-hint">
                      defaults for new Codex sessions — blank = Codex default.
                      {codexVps
                        ? <> catalog via <b>{codexVps.name}</b>.</>
                        : <> no codex-capable VPS connected yet — enter ids manually.</>}
                    </p>
                    {codexVps ? (
                      <>
                        <label>default model
                          <CodexModelPicker
                            catalogVersion={modelNotices.codex.map((m) => m.id).join(",")}
                            vpsId={codexVps.id}
                            value={s['codex.default_model'] ?? ''}
                            onChange={(v) => set('codex.default_model', v)}
                            inheritPlaceholder="Codex default"
                          />
                          <ModelReleaseNotice key="codex" provider="codex" unread={modelNotices.codex} onSeen={onModelsSeen} />
                        </label>
                        <label>default effort
                          <CodexEffortPicker
                            vpsId={codexVps.id}
                            modelId={s['codex.default_model'] || undefined}
                            value={s['codex.default_effort'] ?? ''}
                            onChange={(v) => set('codex.default_effort', v)}
                            inheritPlaceholder="Codex default"
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>default model
                          <input value={s['codex.default_model'] ?? ''} onChange={(e) => set('codex.default_model', e.target.value)} placeholder="gpt-5.6-sol" autoComplete="off" spellCheck={false} />
                          <ModelReleaseNotice key="codex" provider="codex" unread={modelNotices.codex} onSeen={onModelsSeen} />
                        </label>
                        <label>default effort
                          <input value={s['codex.default_effort'] ?? ''} onChange={(e) => set('codex.default_effort', e.target.value)} placeholder="medium" autoComplete="off" spellCheck={false} />
                        </label>
                      </>
                    )}
                    <label>default mode
                      <PickerControl
                        value={s['codex.default_permission_mode'] ?? 'workspace-write'}
                        onValueChange={(nextValue) => set('codex.default_permission_mode', nextValue)}
                      >
                        {CODEX_SANDBOX_MODES.map((mode) => (
                          <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>
                        ))}
                      </PickerControl>
                    </label>
                    <div className="switch-row">
                      <span>automatic approval reviewer</span>
                      <Toggle
                        checked={(s['codex.default_approvals_reviewer'] ?? 'auto_review') === 'auto_review'}
                        onChange={(v) => set('codex.default_approvals_reviewer', v ? 'auto_review' : 'user')}
                        label="let the Codex reviewer decide approvals for new sessions"
                      />
                    </div>
                    <p className="set-meta">
                      New sessions inherit this reviewer. It may still escalate
                      sensitive actions; choose “accept all” as the mode when no
                      approval card should ever appear.
                    </p>
                  </>
                )}

                {cat === 'notifications' && (
                  <div className="notification-settings">
                    <h3 className="notification-page-title">Notifications</h3>
                    <p className="notification-intro">Choose which events you receive on each channel.</p>
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
                    <p className="notification-note">Browser changes are saved automatically. Click Save to apply Telegram settings.</p>
                    {browserError && <p className="notification-error" role="alert">{browserError}</p>}
                      <details className="notification-connection">
                        <summary>Telegram connection <span aria-hidden="true">›</span></summary>
                        <p className="set-hint">Reply to permission requests and questions from Telegram. Create a bot with <code>@BotFather</code>.</p>
                        <label>bot token
                          <input value={s['telegram.bot_token'] ?? ''} onChange={(e) => set('telegram.bot_token', e.target.value)} placeholder="123456:ABC-…" type="text" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                        </label>
                        <label>chat_id
                          <input value={s['telegram.chat_id'] ?? ''} onChange={(e) => set('telegram.chat_id', e.target.value)} placeholder="123456789" inputMode="numeric" />
                        </label>
                        <div className="tg-test-row">
                          <button type="button" onClick={testTelegram} disabled={testing || s['telegram.enabled'] !== 'true' || !s['telegram.bot_token'] || !s['telegram.chat_id']}>
                            {testing ? 'sending…' : 'Test connection'}
                          </button>
                          {testResult && <span className={`tg-result ${testResult.ok ? 'ok' : 'err'}`}>{testResult.msg}</span>}
                        </div>
                      </details>
                    <NotificationExceptions onOpen={setSessionSettings} />
                  </div>
                )}

                {cat === 'updates' && (
                  <>
                    <div className="switch-row">
                      <span>auto-update Claude (SDK + agent) when a VPS is idle</span>
                      <Toggle
                        checked={(s['sdk.auto_update'] ?? 'true') === 'true'}
                        onChange={(v) => set('sdk.auto_update', v ? 'true' : 'false')}
                        label="auto-update claude SDK when a VPS is idle"
                      />
                    </div>
                    <div className="switch-row">
                      <span>auto-update Codex (Python SDK + CLI) when a VPS is idle</span>
                      <Toggle
                        checked={(s['codex.auto_update'] ?? 'true') === 'true'}
                        onChange={(v) => set('codex.auto_update', v ? 'true' : 'false')}
                        label="auto-update codex when a VPS is idle"
                      />
                    </div>
                    {(s['sdk.latest_version'] || s['codex.latest_version'] || s['codex.cli_latest_version']) && (
                      <p className="set-meta">
                        latest releases:
                        {s['sdk.latest_version'] && <> claude-agent-sdk <b>{s['sdk.latest_version']}</b></>}
                        {s['sdk.latest_version'] && s['codex.latest_version'] && ' · '}
                        {s['codex.latest_version'] && <> openai-codex <b>{s['codex.latest_version']}</b></>}
                        {s['codex.cli_latest_version'] && <> · codex-cli <b>{s['codex.cli_latest_version']}</b></>}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="settings-foot modal-actions">
              <button className="primary" onClick={save} disabled={busy}>save</button>
              <button onClick={close}>cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
    {sessionSettings && <SessionSettingsModal session={sessionSettings} onClose={() => setSessionSettings(null)} />}
    </>
  );
}
