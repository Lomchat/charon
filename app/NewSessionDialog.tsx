'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  initial?: { vpsId?: string; cwd?: string };
  onClose: () => void;
  onCreated: (id: string) => void;
};

export default function NewSessionDialog({
  vpsList, vpsPaths, initial, onClose, onCreated,
}: Props) {
  const [vpsId, setVpsId] = useState(initial?.vpsId ?? vpsList[0]?.id ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [name, setName] = useState('');
  // Toujours créé en "auto" (classifier natif Claude) — l'utilisateur change via le switch dans le chat
  const permissionMode = 'auto' as const;
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Feedback inline du clic "installer le SDK" (au lieu d'une alert intrusive)
  const [setupLog, setSetupLog] = useState<null | { ok: boolean; tail: string; version: string | null }>(null);
  const [setupLogOpen, setSetupLogOpen] = useState(false);

  // Suggestions de chemins : paths connus pour ce VPS
  const cwdSuggestions = useMemo(() => {
    return vpsPaths
      .filter((p) => p.vpsId === vpsId)
      .map((p) => p.path)
      .sort();
  }, [vpsId, vpsPaths]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!vpsId) return;
    setCheck(null);
    api.checkVpsClaude(vpsId)
      .then((r) => setCheck(r))
      .catch((e) => setCheck({ ok: false, error: String(e?.message ?? e) }));
  }, [vpsId]);

  async function setup() {
    setBusy(true);
    setSetupLog(null);
    setSetupLogOpen(false);
    try {
      const r = await api.setupVpsClaude(vpsId);
      const out = (r.stdout || '') + '\n' + (r.stderr || '');
      // pip dit "Requirement already satisfied" si le SDK est déjà là — on
      // détecte ça comme un succès muet (l'idempotence est attendue).
      const alreadyOk = /Requirement already satisfied/i.test(out);
      const versionMatch = out.match(/version:\s*([\d.]+\S*)/i);
      setSetupLog({
        ok: r.ok,
        tail: out.slice(-1500).trim(),
        version: versionMatch ? versionMatch[1] : null,
      });
      // On ouvre le détail SEULEMENT si ça a foiré — sinon juste un toast OK
      setSetupLogOpen(!r.ok && !alreadyOk);
      const c = await api.checkVpsClaude(vpsId);
      setCheck(c);
    } catch (e: any) {
      setSetupLog({ ok: false, tail: String(e?.message ?? e), version: null });
      setSetupLogOpen(true);
    } finally { setBusy(false); }
  }

  async function create() {
    if (!vpsId || !cwd.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.createClaudeSession({
        vpsId, cwd: cwd.trim(),
        name: name.trim() || null,
        permissionMode,
      });
      onCreated(r.id);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>nouvelle session</h2>

        <label>VPS
          <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
            {vpsList.map((v) => (
              <option key={v.id} value={v.id}>{v.name} ({v.sshUser}@{v.ip})</option>
            ))}
          </select>
        </label>

        <div className="check-info">
          {check === null && <em>vérification du VPS…</em>}
          {check && check.ok && (
            <span className="ok">
              ✓ sdk {check.sdk}, python {check.python}
              {/* cli/auth en hint discret seulement si non détectés — la
                 session marche quand même (claude est probablement installé
                 via nvm/bun/volta, invisible au PATH de SSH non-interactif). */}
              {(!check.cliInstalled || check.authOk === false) && (
                <span className="hint">
                  {' — '}
                  {!check.cliInstalled && 'cli non détecté'}
                  {!check.cliInstalled && check.authOk === false && ', '}
                  {check.authOk === false && 'login non détecté'}
                  {' (ok si la session marche)'}
                </span>
              )}
            </span>
          )}
          {check && !check.ok && (
            <>
              <span className="warn">⚠ sdk manquant</span>
              <button onClick={setup} disabled={busy}>
                {busy ? 'installation…' : 'installer le SDK'}
              </button>
            </>
          )}
          {setupLog && (
            <div className={`setup-log ${setupLog.ok ? 'ok' : 'err'}`} style={{ marginTop: 6, fontSize: 12 }}>
              <span>
                {setupLog.ok
                  ? `✓ install OK${setupLog.version ? ` · sdk ${setupLog.version}` : ''}`
                  : '✗ install échoué'}
              </span>
              {' '}
              <button
                type="button"
                onClick={() => setSetupLogOpen((v) => !v)}
                style={{ background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
              >
                {setupLogOpen ? 'masquer détail' : 'voir détail'}
              </button>
              {setupLogOpen && (
                <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', padding: 8, marginTop: 4, borderRadius: 4 }}>
                  {setupLog.tail || '(sortie vide)'}
                </pre>
              )}
            </div>
          )}
        </div>

        <label>cwd (chemin sur le VPS)
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/srv/mon-projet"
            list={`cwd-suggest-${vpsId}`}
          />
          <datalist id={`cwd-suggest-${vpsId}`}>
            {cwdSuggestions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>

        <label>nom (optionnel)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex : refacto auth" />
        </label>

        {err && <div className="modal-err">{err}</div>}

        <div className="modal-actions">
          <button className="primary" onClick={create} disabled={busy || !cwd.trim() || !vpsId}>démarrer</button>
          <button onClick={onClose}>annuler</button>
        </div>
      </div>
    </div>
  );
}
