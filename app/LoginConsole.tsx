'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';

type Props = {
  vps: Vps;
  onClose: () => void;
};

type ConsoleEvent = { kind: 'stdout' | 'stderr' | 'meta'; text: string };

/**
 * Console interactive pour `claude login` distant.
 *
 * `claude login` en version récente ouvre un TUI : prompt "trust this folder"
 * puis flow OAuth. Le PTY remote nous envoie plein de séquences ANSI (CSI,
 * cursor moves, bracketed paste, etc.) — on les strip pour l'affichage. On
 * expose aussi des boutons pour les touches spéciales (↑ ↓ Enter Esc Ctrl+C)
 * indispensables pour répondre aux prompts.
 */

// Strip ANSI escape sequences.
//   ESC [ ... letter      →  CSI : couleurs, déplacements curseur, etc.
//   ESC ] ... BEL/ST      →  OSC : titre fenêtre etc.
//   ESC c, ESC 7, …       →  séquences à 1-2 char
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')                // CSI
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')        // OSC
    .replace(/\x1b[=>78cDEHMNOZ]/g, '')                    // 1-2 char escapes
    .replace(/\x1b\([AB012]/g, '')                         // character set
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');             // contrôle sauf \n \t
}

function cleanText(raw: string): string {
  return stripAnsi(raw).replace(/\r\n?/g, '\n');
}

export default function LoginConsole({ vps, onClose }: Props) {
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [input, setInput] = useState('');
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Echap ferme la modale (sauf si on a focus l'input — Échap dans l'input
  // envoie un ESC au TUI pour annuler une action distante)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-scroll
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/vps/${vps.id}/login`, { method: 'POST' });
        if (!res.ok) throw new Error(`start: HTTP ${res.status}`);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
        return;
      }
      if (cancelled) return;
      const es = new EventSource(`/api/vps/${vps.id}/login/stream`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const ev: ConsoleEvent = JSON.parse(e.data);
          setEvents((p) => [...p, ev]);
          if (ev.kind === 'meta' && /closed|exited/.test(ev.text)) {
            setClosed(true);
          }
        } catch {}
      };
      es.onerror = () => {
        // Connexion fermée — c'est OK si la session a terminé
      };
    })();
    return () => {
      cancelled = true;
      if (esRef.current) esRef.current.close();
      fetch(`/api/vps/${vps.id}/login`, { method: 'DELETE' }).catch(() => {});
    };
  }, [vps.id]);

  const sendRaw = async (content: string, echoLabel?: string) => {
    if (closed) return;
    if (echoLabel) {
      setEvents((p) => [...p, { kind: 'meta', text: `→ ${echoLabel}` }]);
    }
    try {
      const res = await fetch(`/api/vps/${vps.id}/login/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setEvents((p) => [...p, { kind: 'meta', text: `[charon] envoi échoué : ${err?.error ?? res.status}` }]);
      }
    } catch (e: any) {
      setEvents((p) => [...p, { kind: 'meta', text: `[charon] erreur réseau : ${e?.message ?? e}` }]);
    }
  };

  const sendText = () => {
    const text = input;
    setInput('');
    sendRaw(text + '\n', text || '<enter>');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendText();
    } else if (e.key === 'ArrowUp' && !input) {
      e.preventDefault();
      sendRaw('\x1b[A', '↑');
    } else if (e.key === 'ArrowDown' && !input) {
      e.preventDefault();
      sendRaw('\x1b[B', '↓');
    } else if (e.key === 'Escape' && !input) {
      e.preventDefault();
      sendRaw('\x1b', 'Esc');
    }
  };

  // Mémoise le rendu des lignes (strip ANSI + split sur \n + concaténation
  // des outputs partiels qui ne finissent pas par \n).
  const lines = useMemo(() => {
    const out: { text: string; kind: ConsoleEvent['kind']; key: number }[] = [];
    let key = 0;
    for (const ev of events) {
      if (ev.kind === 'meta') {
        out.push({ text: ev.text, kind: 'meta', key: key++ });
        continue;
      }
      const cleaned = cleanText(ev.text);
      if (!cleaned) continue;
      const last = out[out.length - 1];
      if (last && last.kind !== 'meta' && !last.text.endsWith('\n')) {
        const merged = last.text + cleaned;
        const split = merged.split('\n');
        last.text = split[0];
        for (let i = 1; i < split.length; i++) {
          out.push({ text: split[i], kind: ev.kind, key: key++ });
        }
      } else {
        const split = cleaned.split('\n');
        for (const s of split) {
          out.push({ text: s, kind: ev.kind, key: key++ });
        }
      }
    }
    // Supprime lignes vides en fin
    while (out.length > 0 && out[out.length - 1].kind !== 'meta' && !out[out.length - 1].text.trim()) {
      out.pop();
    }
    return out;
  }, [events]);

  const renderLine = (text: string, kind: string, key: number) => {
    const urlRe = /(https?:\/\/[^\s]+)/g;
    if (!urlRe.test(text)) {
      return <div key={key} className={`login-line kind-${kind}`}>{text || ' '}</div>;
    }
    urlRe.lastIndex = 0;
    const parts: (string | { url: string })[] = [];
    let m: RegExpExecArray | null;
    let lastIdx = 0;
    while ((m = urlRe.exec(text)) !== null) {
      if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
      parts.push({ url: m[1] });
      lastIdx = m.index + m[1].length;
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    return (
      <div key={key} className={`login-line kind-${kind}`}>
        {parts.map((p, i) =>
          typeof p === 'string'
            ? <span key={i}>{p}</span>
            : <a key={i} href={p.url} target="_blank" rel="noreferrer">{p.url}</a>
        )}
      </div>
    );
  };

  return (
    <div className="login-console-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="login-console-card">
        <header>
          <span className="title">claude login — {vps.name}</span>
          <span className="hint">↑↓ pour naviguer · Enter pour valider · URL = clique · code OAuth = colle ici</span>
          <button onClick={onClose} className="dismiss">✕</button>
        </header>
        {error && <div className="login-error">{error}</div>}
        <div ref={consoleRef} className="login-console">
          {lines.length === 0 && !error && (
            <div className="login-line kind-meta">[charon] démarrage de la session SSH…</div>
          )}
          {lines.map((l) => renderLine(l.text, l.kind, l.key))}
        </div>
        <div className="login-keys">
          <button onClick={() => sendRaw('\x1b[A', '↑')} disabled={closed} title="flèche haut">↑</button>
          <button onClick={() => sendRaw('\x1b[B', '↓')} disabled={closed} title="flèche bas">↓</button>
          <button onClick={() => sendRaw('\n', '<enter>')} disabled={closed} title="valider">Enter</button>
          <button onClick={() => sendRaw('\x1b', 'Esc')} disabled={closed} title="annuler">Esc</button>
          <button onClick={() => sendRaw('\x03', 'Ctrl+C')} disabled={closed} title="interrompre" className="danger">Ctrl+C</button>
        </div>
        <div className="login-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={closed}
            placeholder={closed ? 'session terminée' : 'tape ici ou colle le code OAuth, puis Enter'}
            autoFocus
            spellCheck={false}
          />
          <button onClick={sendText} disabled={closed}>envoyer</button>
        </div>
      </div>
    </div>
  );
}
