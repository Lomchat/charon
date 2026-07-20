'use client';
// TEMP prototype v1 — « Claudeville » : village 2D top-down en canvas pur.
// Chaque maison = un VPS, chaque personnage = une session Claude.
import { useEffect, useRef, useState } from 'react';
import { STATUS_COLOR, useMockFleet, VPSES, type MockAgent } from '../mock';
import { AgentPanel, EventTicker, ProtoBanner } from '../ProtoChrome';

interface Sprite {
  x: number;
  y: number;
  tx: number;
  ty: number;
  nextMove: number;
  walking: boolean;
}

const HOUSE_X = [0.18, 0.5, 0.82];

// pseudo-random déterministe (décor stable d'une frame à l'autre)
function sr(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export default function Village() {
  const { agents, events } = useMockFleet();
  const [selId, setSelId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const selRef = useRef(selId);
  selRef.current = selId;
  const spritesRef = useRef(new Map<string, Sprite>());
  const hitRef = useRef(new Map<string, { x: number; y: number; w: number; h: number }>());

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    let W = 0;
    let H = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cv.clientWidth;
      H = cv.clientHeight;
      cv.width = Math.max(1, Math.floor(W * dpr));
      cv.height = Math.max(1, Math.floor(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    };

    const drawHouse = (i: number, t: number, busy: boolean) => {
      const v = VPSES[i];
      const hx = HOUSE_X[i] * W;
      const hy = H * 0.3;
      // ombre
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath();
      ctx.ellipse(hx, hy + 52, 80, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      // mur
      ctx.fillStyle = '#f0dcb0';
      ctx.fillRect(hx - 62, hy - 12, 124, 62);
      ctx.strokeStyle = '#c9ab77';
      ctx.lineWidth = 2;
      ctx.strokeRect(hx - 62, hy - 12, 124, 62);
      // toit couleur VPS
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.moveTo(hx - 74, hy - 12);
      ctx.lineTo(hx + 74, hy - 12);
      ctx.lineTo(hx, hy - 62);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.25)';
      ctx.stroke();
      // cheminée + fumée quand ça bosse
      ctx.fillStyle = '#9a6a3a';
      ctx.fillRect(hx + 30, hy - 54, 12, 24);
      if (busy) {
        for (let k = 0; k < 3; k++) {
          const yy = (t * 22 + k * 14) % 40;
          ctx.fillStyle = `rgba(232,237,247,${0.7 * (1 - yy / 40)})`;
          ctx.beginPath();
          ctx.arc(hx + 36 + Math.sin((t + k) * 2) * 4, hy - 58 - yy, 5 + yy / 9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // porte
      ctx.fillStyle = '#7a4f2a';
      ctx.fillRect(hx - 12, hy + 14, 24, 36);
      ctx.fillStyle = '#ffd24a';
      ctx.fillRect(hx + 5, hy + 32, 3, 3);
      // fenêtres (allumées quand ça bosse)
      for (const wx of [hx - 46, hx + 26]) {
        ctx.fillStyle = busy ? '#ffe9a3' : '#bfe6ff';
        ctx.fillRect(wx, hy + 2, 20, 16);
        ctx.strokeStyle = '#8a6f47';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(wx, hy + 2, 20, 16);
        ctx.beginPath();
        ctx.moveTo(wx + 10, hy + 2);
        ctx.lineTo(wx + 10, hy + 18);
        ctx.moveTo(wx, hy + 10);
        ctx.lineTo(wx + 20, hy + 10);
        ctx.stroke();
      }
      // plaque nom + ip
      ctx.fillStyle = 'rgba(58,42,24,.92)';
      rr(hx - 56, hy + 56, 112, 26, 6);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.fillStyle = '#ffe9c9';
      ctx.fillText(v.name, hx, hy + 66);
      ctx.font = '8.5px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255,233,201,.6)';
      ctx.fillText(v.ip, hx, hy + 76);
      ctx.textAlign = 'left';
    };

    const drawAgent = (a: MockAgent, sp: Sprite, t: number) => {
      const jx = a.status === 'error' ? Math.sin(t * 40 + sp.x) * 1.5 : 0;
      const X = sp.x + jx;
      const y = sp.y;
      ctx.globalAlpha = a.status === 'sleeping' ? 0.72 : 1;
      // ombre
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath();
      ctx.ellipse(X, y + 2, 9, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // anneau de sélection
      if (a.id === selRef.current) {
        ctx.strokeStyle = '#ffb400';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(X, y + 2, 14, 6, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // jambes
      const step = sp.walking ? Math.sin(t * 11 + sp.x) * 2 : 0;
      ctx.fillStyle = '#3a4a6b';
      ctx.fillRect(X - 5, y - 8 + Math.max(0, step), 4, 8 - Math.max(0, step));
      ctx.fillRect(X + 1, y - 8 + Math.max(0, -step), 4, 8 - Math.max(0, -step));
      // corps
      ctx.fillStyle = a.color;
      rr(X - 7, y - 17, 14, 10, 3);
      ctx.fill();
      // tête
      ctx.fillStyle = '#ffd9b3';
      ctx.fillRect(X - 5, y - 26, 10, 9);
      ctx.fillStyle = '#4a3320';
      ctx.fillRect(X - 5, y - 26, 10, 3);
      ctx.fillStyle = '#222';
      if (a.status === 'sleeping') {
        ctx.fillRect(X - 3, y - 21, 2, 1);
        ctx.fillRect(X + 1, y - 21, 2, 1);
      } else {
        ctx.fillRect(X - 3, y - 21, 2, 2);
        ctx.fillRect(X + 1, y - 21, 2, 2);
      }
      ctx.globalAlpha = 1;
      // pastille nom + statut
      ctx.font = '600 10px "JetBrains Mono", monospace';
      const nw = ctx.measureText(a.name).width;
      const pw = nw + 20;
      const px = X - pw / 2;
      ctx.fillStyle = 'rgba(19,26,44,.85)';
      rr(px, y - 44, pw, 15, 7);
      ctx.fill();
      ctx.fillStyle = STATUS_COLOR[a.status];
      ctx.beginPath();
      ctx.arc(px + 8, y - 36.5, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.name, px + 14, y - 36);
      // bulle de pensée (outil en cours)
      if (a.status === 'thinking' && a.tool) {
        const dots = '.'.repeat(1 + (Math.floor(t * 2) % 3));
        const label = `💭 ${a.tool.length > 22 ? a.tool.slice(0, 21) + '…' : a.tool}${dots}`;
        ctx.font = '10px "JetBrains Mono", monospace';
        const bw = ctx.measureText(label).width + 14;
        const bx = X - bw / 2;
        const by = y - 66;
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.strokeStyle = '#3a4a6b';
        ctx.lineWidth = 1;
        rr(bx, by, bw, 17, 8);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X - 3, by + 17);
        ctx.lineTo(X + 3, by + 17);
        ctx.lineTo(X, by + 22);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#1b2340';
        ctx.fillText(label, bx + 7, by + 9);
      }
      if (a.status === 'sleeping') {
        const fl = (t * 14 + sp.x) % 18;
        ctx.font = '600 11px "JetBrains Mono", monospace';
        ctx.fillStyle = `rgba(70,100,150,${Math.max(0, 1 - fl / 18)})`;
        ctx.fillText('z', X + 8, y - 30 - fl);
        ctx.fillText('Z', X + 14, y - 36 - fl);
      }
      if (a.status === 'error') {
        ctx.fillStyle = '#ff4d5e';
        rr(X - 9, y - 64, 18, 16, 6);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', X, y - 55.5);
        ctx.textAlign = 'left';
      }
      hitRef.current.set(a.id, { x: X - 16, y: y - 66, w: 32, h: 72 });
    };

    const draw = (t: number, dt: number) => {
      const pathY = H * 0.56;
      // herbe en damier
      const T = 30;
      for (let gy = 0; gy <= H / T; gy++) {
        for (let gx = 0; gx <= W / T; gx++) {
          ctx.fillStyle = (gx + gy) % 2 ? '#8ec868' : '#86bf60';
          ctx.fillRect(gx * T, gy * T, T, T);
        }
      }
      // fleurs
      for (let i = 0; i < 46; i++) {
        ctx.fillStyle = ['#ffffff', '#ffd24a', '#ff8fb3'][i % 3];
        ctx.fillRect(sr(i) * W, sr(i + 99) * H, 3, 3);
      }
      // étang (haut droite)
      const pxx = W * 0.9;
      const pyy = H * 0.1;
      ctx.fillStyle = '#7cc7ea';
      ctx.strokeStyle = '#5ba8cf';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(pxx, pyy, 64, 28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 1.5;
      for (let k = 0; k < 2; k++) {
        const rp = ((t * 14 + k * 22) % 44) / 44;
        ctx.globalAlpha = 1 - rp;
        ctx.beginPath();
        ctx.ellipse(pxx, pyy, 10 + rp * 40, 4 + rp * 18, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // chemins
      ctx.fillStyle = '#e8d5a5';
      ctx.fillRect(0, pathY - 14, W, 28);
      ctx.fillStyle = '#dcc691';
      ctx.fillRect(0, pathY - 14, W, 3);
      ctx.fillRect(0, pathY + 11, W, 3);
      for (let i = 0; i < 3; i++) {
        const hx = HOUSE_X[i] * W;
        const hy = H * 0.3;
        ctx.fillStyle = '#e8d5a5';
        ctx.fillRect(hx - 12, hy + 50, 24, pathY - hy - 50);
      }
      // place centrale + fontaine
      ctx.fillStyle = '#e8d5a5';
      ctx.beginPath();
      ctx.arc(W / 2, pathY, 48, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9ad4f2';
      ctx.strokeStyle = '#c9d4da';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(W / 2, pathY, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (let k = 0; k < 3; k++) {
        const yy = (t * 30 + k * 12) % 26;
        ctx.fillStyle = `rgba(255,255,255,${1 - yy / 26})`;
        ctx.fillRect(W / 2 - 6 + k * 5, pathY - 8 - yy, 3, 3);
      }
      // panneau CHARON
      ctx.fillStyle = '#7a4f2a';
      ctx.fillRect(W / 2 - 2, pathY - 74, 4, 24);
      ctx.fillStyle = '#8a5a2b';
      rr(W / 2 - 40, pathY - 92, 80, 20, 4);
      ctx.fill();
      ctx.fillStyle = '#ffe9c9';
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚡ CHARON', W / 2, pathY - 81);
      ctx.textAlign = 'left';
      // arbres
      for (let i = 0; i < 12; i++) {
        const zone = i % 2;
        const txx = sr(i * 7 + 3) * W;
        const tyy = zone ? H * (0.66 + sr(i * 13) * 0.28) : H * (0.02 + sr(i * 13) * 0.08);
        ctx.fillStyle = '#8a5a2b';
        ctx.fillRect(txx - 3, tyy + 8, 6, 12);
        ctx.fillStyle = '#4e9a3f';
        ctx.beginPath();
        ctx.arc(txx, tyy, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#5fae4c';
        ctx.beginPath();
        ctx.arc(txx - 9, tyy + 6, 10, 0, Math.PI * 2);
        ctx.arc(txx + 9, tyy + 6, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      // maisons
      for (let i = 0; i < 3; i++) {
        const busy = agentsRef.current.some(a => a.vpsId === VPSES[i].id && a.status === 'thinking');
        drawHouse(i, t, busy);
      }
      // déplacement des personnages
      hitRef.current.clear();
      for (const a of agentsRef.current) {
        const vi = Math.max(0, VPSES.findIndex(v => v.id === a.vpsId));
        const slot = agentsRef.current.filter(x => x.vpsId === a.vpsId).findIndex(x => x.id === a.id);
        const hx = HOUSE_X[vi] * W;
        const hy = H * 0.3;
        const home = { x: hx - 52 + slot * 42, y: hy + 96 };
        let sp = spritesRef.current.get(a.id);
        if (!sp) {
          sp = { x: home.x, y: home.y, tx: home.x, ty: home.y, nextMove: 0, walking: false };
          spritesRef.current.set(a.id, sp);
        }
        if (a.status === 'sleeping' || a.status === 'error') {
          sp.tx = home.x;
          sp.ty = home.y;
        } else if (t > sp.nextMove) {
          sp.nextMove = t + 1.5 + sr(t * 7 + slot) * 3;
          const yr = Math.max(14, pathY - hy - 110);
          if (a.status === 'thinking') {
            sp.tx = hx - 16 + sr(t * 3 + slot * 5) * 32;
            sp.ty = hy + 86 + sr(t * 5 + slot * 9) * yr;
          } else {
            sp.tx = hx - 90 + sr(t * 11 + slot) * 180;
            sp.ty = hy + 82 + sr(t * 17 + slot) * (yr + 14);
          }
        }
        const dx = sp.tx - sp.x;
        const dy = sp.ty - sp.y;
        const d = Math.hypot(dx, dy);
        const speed = a.status === 'thinking' ? 52 : 34;
        if (d > 2) {
          sp.x += (dx / d) * speed * dt;
          sp.y += (dy / d) * speed * dt;
          sp.walking = true;
        } else {
          sp.walking = false;
        }
      }
      // dessin trié par y (painter order)
      agentsRef.current
        .map(a => ({ a, sp: spritesRef.current.get(a.id) as Sprite }))
        .sort((p, q) => p.sp.y - q.sp.y)
        .forEach(({ a, sp }) => drawAgent(a, sp, t));
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (W > 0 && H > 0) draw(now / 1000, dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let hit: string | null = null;
    hitRef.current.forEach((r, id) => {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) hit = id;
    });
    setSelId(hit);
  };

  const sel = agents.find(a => a.id === selId) ?? null;

  return (
    <div className="proto-root">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }}
      />
      <ProtoBanner
        v={1}
        title="Proto v1 — Claudeville (village 2D)"
        sub="chaque maison = un VPS · chaque personnage = une session · clic sur un personnage pour lui parler"
      />
      <EventTicker events={events} />
      {sel && <AgentPanel key={sel.id} agent={sel} vps={VPSES.find(v => v.id === sel.vpsId)} onClose={() => setSelId(null)} />}
    </div>
  );
}
