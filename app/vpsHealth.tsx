'use client';
import type { Vps } from '@/lib/db/schema';
import type { AgentKind } from '@/lib/types/api';
import { isVersionOutdated } from '@/lib/version';

// ── Per-VPS health diagnosis (single source of truth) ────────────────────────
// Turns the vps row's health columns (agentStatus + agentLastError +
// claudeLoggedIn/sdkVersion + codexAvailable/codexLoggedIn) into FOUR explicit
// axes — ssh / agent / claude / codex — each with a compact label, a tooltip
// detail and (when the hub can repair it) ITS OWN fix buttons. Consumed by:
//   - DataModal (chips row on every VPS card — each broken chip is followed
//     by its repair button: problem → fix, PAIRED)
//   - NewSessionWizard (one "⚠ reason [fix]" line per problem)
//   - Sidebar (backend availability of the ＋ Claude/Codex buttons + error bar)
// The point: "VPS unavailable" is never a mystery — the user sees WHICH layer
// is broken (VPS unreachable over SSH? key refused? agent not deployed? agent
// daemon stopped? claude not signed in? codex not installed?) and gets the
// right one-click repair NEXT TO the problem it repairs. cf. CLAUDE.md §14.60.

export type VpsFixAction = 'install' | 'refresh' | 'update' | 'claude-login' | 'codex-login';
export type VpsAxisState = 'ok' | 'warn' | 'err' | 'unk';

export type VpsFix = {
  action: VpsFixAction;
  label: string;   // button text ("▸ install agent", "↻ start agent"…)
  title: string;   // button tooltip
  primary?: boolean;
};

export type VpsHealthAxis = {
  key: 'ssh' | 'agent' | 'claude' | 'codex';
  state: VpsAxisState;
  label: string;   // compact chip text ("ssh ✓", "no agent", "claude: login"…)
  detail: string;  // tooltip sentence (may embed the raw ssh error)
  // Repair buttons for THIS axis's problem — rendered right after the chip
  // (problem → fix pairing; the user asked for exactly this, not a trailing
  // button cluster). Empty/absent when the axis is fine or hub-unfixable.
  fixes?: VpsFix[];
};

export type VpsHealth = {
  agentStatus: string;
  // Classified error code parsed from vps.agentLastError (null when n/a):
  // 'ssh-auth' | 'ssh-unreachable' | 'daemon-down' | 'error'.
  errCode: string | null;
  axes: VpsHealthAxis[];   // always the 4 axes, in ssh→agent→claude→codex order
  // Aggregate of the per-axis fixes, deduped by action (axis order = priority,
  // `primary` sticks if ANY axis flagged it). For consumers that want ONE
  // button per action (availability fallbacks) — the chips render per-axis.
  fixes: VpsFix[];
};

/** Split `vps.agentLastError` ('<code>: <detail>') into its two halves. */
export function parseAgentLastError(v: Vps): { code: string | null; detail: string | null } {
  const raw = (v as any).agentLastError as string | null | undefined;
  if (!raw) return { code: null, detail: null };
  const i = raw.indexOf(':');
  if (i < 0) return { code: raw.trim() || null, detail: null };
  return { code: raw.slice(0, i).trim() || null, detail: raw.slice(i + 1).trim() || null };
}

export function diagnoseVps(
  v: Vps,
  opts?: { builtPyzSha?: string | null; sdkLatestVersion?: string | null },
): VpsHealth {
  const status = ((v as any).agentStatus as string | undefined) ?? 'unknown';
  const { code, detail } = parseAgentLastError(v);
  const agentVersion = (v as any).agentVersion as string | null | undefined;
  const agentPyzSha = (v as any).agentPyzSha as string | null | undefined;
  const sdkVersion = (v as any).sdkVersion as string | null | undefined;
  const claudeLoggedIn = (v as any).claudeLoggedIn as number | null | undefined;
  const codexAvailable = (v as any).codexAvailable as number | null | undefined;
  const codexLoggedIn = (v as any).codexLoggedIn as number | null | undefined;

  const axes: VpsHealthAxis[] = [];
  const errSuffix = detail ? ` — ${detail}` : '';

  // ── ssh ────────────────────────────────────────────────────────────────────
  // 'ok'/'missing' both PROVE ssh works (the remote command ran). 'error' is
  // ssh-level only when the classified code says so; a daemon-down error also
  // proves ssh works.
  if (status === 'ok' || status === 'missing' || (status === 'error' && code === 'daemon-down')) {
    axes.push({ key: 'ssh', state: 'ok', label: 'ssh ✓', detail: 'SSH reachable' });
  } else if (status === 'error' && code === 'ssh-auth') {
    axes.push({
      key: 'ssh', state: 'err', label: 'ssh key ✗',
      detail: `SSH refused the key (wrong/missing key or user)${errSuffix}`,
      fixes: [{ action: 'refresh', label: '↻ retry', title: 'retry the SSH connection', primary: true }],
    });
  } else if (status === 'error' && code === 'ssh-unreachable') {
    axes.push({
      key: 'ssh', state: 'err', label: 'ssh ✗',
      detail: `VPS unreachable over SSH (down / network / firewall)${errSuffix}`,
      fixes: [{ action: 'refresh', label: '↻ retry', title: 'retry the SSH connection', primary: true }],
    });
  } else if (status === 'error') {
    // Legacy error rows (no classified code yet) — can't blame a layer.
    axes.push({ key: 'ssh', state: 'unk', label: 'ssh ?', detail: `connection failed, layer unknown${errSuffix}` });
  } else {
    axes.push({ key: 'ssh', state: 'unk', label: 'ssh ?', detail: 'never tested — check or install' });
  }

  // ── agent (charon-agent daemon) ────────────────────────────────────────────
  if (status === 'ok') {
    const pyzOutdated = !!opts?.builtPyzSha && (agentPyzSha == null || agentPyzSha !== opts.builtPyzSha);
    const sdkOutdated = isVersionOutdated(sdkVersion, opts?.sdkLatestVersion ?? null);
    if (pyzOutdated || sdkOutdated) {
      axes.push({
        key: 'agent', state: 'warn', label: 'agent ⇪',
        detail: `running${agentVersion ? ` v${agentVersion}` : ''} — update available${sdkOutdated && sdkVersion ? ` (sdk ${sdkVersion} → ${opts?.sdkLatestVersion})` : ''}`,
        fixes: [{ action: 'update', label: '⇪ update', title: 'redeploy the agent + update the SDKs', primary: false }],
      });
    } else {
      axes.push({ key: 'agent', state: 'ok', label: 'agent ✓', detail: `charon-agent running${agentVersion ? ` (v${agentVersion})` : ''}` });
    }
  } else if (status === 'missing') {
    axes.push({
      key: 'agent', state: 'err', label: 'no agent',
      detail: 'SSH works but charon-agent is not deployed on this VPS',
      fixes: [{ action: 'install', label: '▸ install agent', title: 'bootstrap the VPS (python + venv + agent + service)', primary: true }],
    });
  } else if (status === 'error' && code === 'daemon-down') {
    axes.push({
      key: 'agent', state: 'err', label: 'agent stopped',
      detail: `installed, but the daemon is not running${errSuffix}`,
      fixes: [{ action: 'refresh', label: '↻ start agent', title: 'start the agent daemon and reconnect', primary: true }],
    });
  } else if (status === 'error' && (code === 'ssh-auth' || code === 'ssh-unreachable')) {
    axes.push({ key: 'agent', state: 'unk', label: 'agent ?', detail: 'unknown while SSH is failing' });
  } else if (status === 'error') {
    axes.push({
      key: 'agent', state: 'err', label: 'agent ✗',
      detail: `connection to the agent dropped${errSuffix}`,
      fixes: [
        { action: 'refresh', label: '↻ refresh', title: 'reconnect (and start the daemon if needed)', primary: true },
        { action: 'install', label: 'reinstall', title: 'redo the full bootstrap', primary: false },
      ],
    });
  } else {
    axes.push({
      key: 'agent', state: 'unk', label: 'agent ?',
      detail: 'never checked on this VPS',
      fixes: [
        { action: 'refresh', label: '✓ check', title: 'try to reach the agent now', primary: false },
        { action: 'install', label: '▸ install agent', title: 'bootstrap the VPS (python + venv + agent + service)', primary: true },
      ],
    });
  }

  // ── claude / codex (only meaningful once the agent answers) ────────────────
  if (status !== 'ok') {
    const why = status === 'missing' ? 'needs the agent installed first' : 'unknown until the agent answers';
    axes.push({ key: 'claude', state: 'unk', label: 'claude ?', detail: why });
    axes.push({ key: 'codex', state: 'unk', label: 'codex ?', detail: why });
  } else {
    // claude — TWO distinct broken states: NOT INSTALLED (sdk missing from
    // the venv) vs INSTALLED BUT NOT SIGNED IN. Same split as codex below.
    if (sdkVersion == null) {
      axes.push({
        key: 'claude', state: 'warn', label: 'claude: not installed',
        detail: 'claude-agent-sdk not in the venv — update (re)installs it',
        fixes: [{ action: 'update', label: '⇪ update', title: 'install/upgrade claude-agent-sdk in the venv', primary: false }],
      });
    } else if (claudeLoggedIn === 0) {
      axes.push({
        key: 'claude', state: 'warn', label: 'claude: login',
        detail: 'installed but not signed in — open the claude login console',
        fixes: [{ action: 'claude-login', label: 'claude login', title: 'open the claude login console', primary: false }],
      });
    } else if (claudeLoggedIn == null) {
      axes.push({
        key: 'claude', state: 'unk', label: 'claude ?',
        detail: 'login never checked — open the console to sign in / verify',
        fixes: [{ action: 'claude-login', label: 'claude login', title: 'open the claude login console', primary: false }],
      });
    } else {
      axes.push({ key: 'claude', state: 'ok', label: 'claude ✓', detail: `signed in${sdkVersion ? ` · sdk ${sdkVersion}` : ''}` });
    }
    // codex — same two states: openai-codex importable in the venv
    // (installed) vs `codex login` done (device-code modal, §14.61).
    if (codexAvailable === 0) {
      axes.push({
        key: 'codex', state: 'warn', label: 'codex: not installed',
        detail: 'openai-codex not in the venv — "install codex" fixes it',
        fixes: [{ action: 'update', label: '⇩ install codex', title: 'install openai-codex in the venv (runs the agent update)', primary: false }],
      });
    } else if (codexAvailable == null) {
      axes.push({
        key: 'codex', state: 'unk', label: 'codex ?',
        detail: 'not reported (old agent) — update to detect/install it',
        fixes: [{ action: 'update', label: '⇪ update', title: 'update the agent (also installs openai-codex)', primary: false }],
      });
    } else if (codexLoggedIn === 0) {
      axes.push({
        key: 'codex', state: 'warn', label: 'codex: login',
        detail: 'installed but not signed in — sign in with the device code',
        fixes: [{ action: 'codex-login', label: 'codex login', title: 'sign in to Codex (ChatGPT device code — no VPS shell needed)', primary: false }],
      });
    } else {
      axes.push({ key: 'codex', state: 'ok', label: 'codex ✓', detail: codexLoggedIn == null ? 'installed (login not verified yet)' : 'installed & signed in' });
    }
  }

  // Aggregate the per-axis fixes, deduped by action — first request wins
  // (axis order = priority), `primary` sticks if ANY requester flagged it.
  const fixes: VpsFix[] = [];
  for (const a of axes) {
    for (const f of a.fixes ?? []) {
      const existing = fixes.find((x) => x.action === f.action);
      if (existing) { existing.primary = existing.primary || f.primary; continue; }
      fixes.push({ ...f });
    }
  }

  return { agentStatus: status, errCode: code, axes, fixes };
}

// ── Availability for the launchers (Sidebar ＋ buttons, wizard rows) ─────────
// Same truth as the axes above, folded into "can I start something here, and
// if not: why (short) + which fix". Replaces the old claudeAvailability/
// codexAvailability duplicated in Sidebar + wizard.

/** Agent-layer availability only (ssh + charon-agent) — what a SHELL needs. */
export function agentAvailability(v: Vps): { ok: boolean; reason: string; fix?: VpsFix } {
  const h = diagnoseVps(v);
  if (h.agentStatus === 'ok') return { ok: true, reason: 'agent up' };
  const reasons: Record<string, string> = {
    'ssh-auth': 'SSH key refused',
    'ssh-unreachable': 'VPS unreachable (SSH)',
    'daemon-down': 'agent stopped',
  };
  const reason =
    h.agentStatus === 'missing' ? 'agent not installed'
    : h.agentStatus === 'unknown' ? 'agent not verified'
    : reasons[h.errCode ?? ''] ?? 'agent unreachable';
  // The blocking fix is agent-level → the first primary (install/refresh).
  const fix = h.fixes.find((f) => f.primary) ?? h.fixes[0];
  return { ok: false, reason, fix };
}

export function backendAvailability(
  v: Vps,
  kind: AgentKind,
): { ok: boolean; reason: string; fix?: VpsFix } {
  const agent = agentAvailability(v);
  if (!agent.ok) return agent;
  if (kind === 'codex') {
    const codexAvailable = (v as any).codexAvailable as number | null | undefined;
    const codexLoggedIn = (v as any).codexLoggedIn as number | null | undefined;
    // Reasons stay backend-NEUTRAL ('not installed', 'not signed in') — every
    // surface already names the backend (wizard "Codex: …" prefix, the codex
    // logo ＋ button's tooltip), so "not signed in to Codex" read redundant.
    if (codexAvailable !== 1) {
      return {
        ok: false,
        reason: codexAvailable === 0 ? 'not installed' : 'not detected (update the agent)',
        fix: { action: 'update', label: '⇩ install codex', title: 'install openai-codex in the venv (runs the agent update)' },
      };
    }
    if (codexLoggedIn === 0) {
      return {
        ok: false,
        reason: 'not signed in',
        fix: { action: 'codex-login', label: 'codex login', title: 'sign in to Codex (ChatGPT device code)' },
      };
    }
    return { ok: true, reason: 'new Codex agent on this VPS' };
  }
  const claudeLoggedIn = (v as any).claudeLoggedIn as number | null | undefined;
  if (claudeLoggedIn !== 1) {
    return {
      ok: false,
      reason: claudeLoggedIn === 0 ? 'not signed in' : 'login not verified',
      fix: { action: 'claude-login', label: 'claude login', title: 'open the claude login console' },
    };
  }
  return { ok: true, reason: 'new Claude agent on this VPS' };
}

// ── Chips renderer (shared look between DataModal / wizard) ──────────────────
// Each chip is IMMEDIATELY followed by its own fix button(s): problem → fix,
// left to right — never a detached button cluster at the end of the row.
export function VpsHealthChips({ health, onFix, busy, omitFixActions }: {
  health: VpsHealth;
  onFix?: (action: VpsFixAction) => void;
  // Actions currently running (spinner label + disabled).
  busy?: Partial<Record<VpsFixAction, boolean>>;
  // Fix actions the host surface already covers with its own button
  // (e.g. the DataModal's permanent "login" button) — chips stay, buttons drop.
  omitFixActions?: VpsFixAction[];
}) {
  return (
    <div className="vh-row">
      {health.axes.map((a) => (
        <span key={a.key} className="vh-pair">
          <span className={`vh-chip ${a.state}`} title={a.detail}>{a.label}</span>
          {onFix && (a.fixes ?? [])
            .filter((f) => !omitFixActions?.includes(f.action))
            .map((f) => (
              <button
                key={`${a.key}-${f.action}`}
                type="button"
                className={`vh-fix${f.primary ? ' primary' : ''}`}
                disabled={!!busy?.[f.action]}
                title={f.title}
                onClick={(e) => { e.stopPropagation(); onFix(f.action); }}
              >{busy?.[f.action] ? '⟳ …' : f.label}</button>
            ))}
        </span>
      ))}
    </div>
  );
}
