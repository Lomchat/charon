'use client';
// TEMP prototype — chrome partagé /v1 /v2 /v3 (bandeau, ticker, panneau agent).
import { useEffect, useRef, useState } from 'react';
import { fmtTokens, STATUS_COLOR, STATUS_LABEL, type MockAgent, type MockEvent, type MockVps } from './mock';

export function ProtoBanner({ v, title, sub }: { v: 1 | 2 | 3; title: string; sub: string }) {
  useEffect(() => {
    document.title = `Charon · proto v${v}`;
  }, [v]);
  return (
    <div className="proto-banner">
      <div className="pb-title">
        {title}
        <small>{sub}</small>
      </div>
      <nav className="pb-nav">
        <a href="/v1" className={v === 1 ? 'on' : ''}>v1 · village</a>
        <a href="/v2" className={v === 2 ? 'on' : ''}>v2 · 3D</a>
        <a href="/v3" className={v === 3 ? 'on' : ''}>v3 · flow</a>
        <a href="/">← hub</a>
      </nav>
    </div>
  );
}

export function EventTicker({ events }: { events: MockEvent[] }) {
  return (
    <div className="proto-ticker">
      {events.slice(-4).map(e => (
        <div key={e.id}>{e.text}</div>
      ))}
    </div>
  );
}

export function AgentPanel({ agent, vps, onClose }: { agent: MockAgent; vps: MockVps | undefined; onClose: () => void }) {
  const [msgs, setMsgs] = useState<{ role: 'agent' | 'user'; text: string }[]>([
    { role: 'agent', text: agent.lastLine },
  ]);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 999999 });
  }, [msgs]);

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    setMsgs(m => [...m, { role: 'user', text: t }]);
    setDraft('');
    setTimeout(() => {
      setMsgs(m => [...m, { role: 'agent', text: `(placeholder — ici la vraie réponse de « ${agent.name} » arriverait en streaming via le SSE Charon)` }]);
    }, 700);
  };

  return (
    <aside className="proto-panel">
      <header>
        <div className="pp-name">{agent.name}</div>
        <button className="pp-close" onClick={onClose} title="fermer">✕</button>
        <div className="pp-meta">
          <span className="pp-chip status" style={{ background: STATUS_COLOR[agent.status] }}>{STATUS_LABEL[agent.status]}</span>
          {vps && <span className="pp-chip">{vps.name} · {vps.ip}</span>}
          <span className="pp-chip">↑ {fmtTokens(agent.tokens)} tokens</span>
          <span className="pp-chip">todos {agent.todosDone}/{agent.todosTotal}</span>
          {agent.tool && <span className="pp-chip">{agent.tool}</span>}
        </div>
      </header>
      <div className="pp-body" ref={bodyRef}>
        <div className="pp-msg hint">maquette — données simulées, pas branché au SDK</div>
        {msgs.map((m, i) => (
          <div key={i} className={`pp-msg ${m.role}`}>{m.text}</div>
        ))}
      </div>
      <div className="pp-input">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder={`Parler à ${agent.name}…`}
        />
        <button onClick={send}>➤</button>
      </div>
    </aside>
  );
}
