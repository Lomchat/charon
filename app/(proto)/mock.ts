'use client';
// TEMP prototype (§ app/(proto)/README.md) — simulation mock partagée par
// /v1 /v2 /v3. Même flotte fictive dans les 3 rendus pour comparer.
// À JETER — rien n'est branché au SDK.
import { useEffect, useRef, useState } from 'react';

export type AgentStatus = 'thinking' | 'active' | 'sleeping' | 'error';

export interface MockVps {
  id: string;
  name: string;
  ip: string;
  color: string;
}

export interface MockAgent {
  id: string;
  name: string;
  vpsId: string;
  status: AgentStatus;
  tool: string | null;
  tokens: number;
  todosDone: number;
  todosTotal: number;
  color: string;
  lastLine: string;
}

export interface MockBgTask {
  id: string;
  agentId: string;
  label: string;
  expiresAt: number;
}

export interface MockEvent {
  id: number;
  text: string;
}

export const STATUS_COLOR: Record<AgentStatus, string> = {
  thinking: '#8b5cf6',
  active: '#2dd4a7',
  sleeping: '#64748b',
  error: '#ff4d5e',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  thinking: 'réfléchit',
  active: 'prêt',
  sleeping: 'en veille',
  error: 'erreur',
};

export const VPSES: MockVps[] = [
  { id: 'chalco', name: 'chalco', ip: '91.108.112.45', color: '#7c5cff' },
  { id: 'hetzner', name: 'hetzner-gpu', ip: '65.109.32.190', color: '#2dd4a7' },
  { id: 'ovh', name: 'ovh-lab', ip: '146.59.233.12', color: '#ffb454' },
];

const INITIAL: MockAgent[] = [
  { id: 'a1', name: 'refacto-sessionops', vpsId: 'chalco', status: 'thinking', tool: 'Edit(sessionOps.ts)', tokens: 12840, todosDone: 3, todosTotal: 7, color: '#e05252', lastLine: 'Je re-câble le flush du buffer assistant avant le switch de modèle, puis je relance le build.' },
  { id: 'a2', name: 'docs-adr', vpsId: 'chalco', status: 'active', tool: null, tokens: 4210, todosDone: 5, todosTotal: 5, color: '#3b82f6', lastLine: '✅ ADR-002 rédigé et relu — dis-moi si je pousse la version anglaise aussi.' },
  { id: 'a3', name: 'train-eval', vpsId: 'hetzner', status: 'thinking', tool: 'Bash(python train.py --epochs 3)', tokens: 48210, todosDone: 1, todosTotal: 4, color: '#e6a23c', lastLine: 'Epoch 2/3 en cours, la loss descend proprement (0.42 → 0.31).' },
  { id: 'a4', name: 'scraper-fix', vpsId: 'hetzner', status: 'sleeping', tool: null, tokens: 0, todosDone: 2, todosTotal: 6, color: '#16a085', lastLine: 'Session en veille — le fix du rate-limit est commité, reste les tests.' },
  { id: 'a5', name: 'bootstrap-v2', vpsId: 'ovh', status: 'error', tool: null, tokens: 8400, todosDone: 0, todosTotal: 3, color: '#9b59b6', lastLine: '⚠ Le venv est cassé (ensurepip manquant) — il faut relancer l’install.' },
  { id: 'a6', name: 'audit-secu', vpsId: 'ovh', status: 'thinking', tool: 'Grep("MASTER_PASSWORD")', tokens: 22050, todosDone: 2, todosTotal: 5, color: '#d35400', lastLine: 'Je passe les routes API au crible, deux findings mineurs pour l’instant.' },
  { id: 'a7', name: 'tri-backlog', vpsId: 'ovh', status: 'sleeping', tool: null, tokens: 0, todosDone: 0, todosTotal: 2, color: '#2c82c9', lastLine: 'En veille — je reprends le tri des issues quand tu veux.' },
];

const TOOLS = [
  'Bash(npm run build)',
  'Bash(npm test)',
  'Read(schema.ts)',
  'Read(CLAUDE.md)',
  'Edit(sessionOps.ts)',
  'Edit(AgentClient.ts)',
  'Grep("subscribe")',
  'Write(README.md)',
  'Bash(git diff --stat)',
  'WebSearch(drizzle migrate)',
];

const DONE_LINES = [
  '✅ Terminé — build vert, 3 fichiers modifiés.',
  '✅ C’est fait, les tests passent. Je te fais un résumé ?',
  '✅ Rapport écrit dans docs/. Prêt pour la suite.',
  '✅ Migration appliquée proprement, rien à signaler.',
];

const BG_LABELS = ['npm test', 'pytest -q', 'next build', 'git bisect run', 'rsync backup'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/**
 * Simulation : fait vivre la flotte mock (turns, tools, tokens, bg tasks)
 * à ~1 tick / 1.4s. Retourne agents + feed d'événements + bg tasks.
 */
export function useMockFleet() {
  const [agents, setAgents] = useState<MockAgent[]>(INITIAL);
  const [events, setEvents] = useState<MockEvent[]>([{ id: 0, text: '[charon] SSE connecté · 3 VPS · 7 sessions (simulation)' }]);
  const [bgTasks, setBgTasks] = useState<MockBgTask[]>([]);
  const agentsRef = useRef<MockAgent[]>(INITIAL.map(a => ({ ...a })));
  const bgRef = useRef<MockBgTask[]>([]);
  const eventsRef = useRef<MockEvent[]>([{ id: 0, text: '[charon] SSE connecté · 3 VPS · 7 sessions (simulation)' }]);
  const evId = useRef(1);

  useEffect(() => {
    const push = (text: string) => {
      eventsRef.current = [...eventsRef.current.slice(-24), { id: evId.current++, text }];
    };
    const iv = setInterval(() => {
      const now = Date.now();
      bgRef.current = bgRef.current.filter(b => b.expiresAt > now);
      for (const a of agentsRef.current) {
        if (a.status === 'thinking') {
          a.tokens += 60 + Math.floor(Math.random() * 480);
          if (Math.random() < 0.22) {
            a.tool = pick(TOOLS);
            push(`[${a.name}] → ${a.tool}`);
          }
          if (Math.random() < 0.06 && a.todosDone < a.todosTotal) a.todosDone++;
          if (Math.random() < 0.045) {
            a.status = 'active';
            a.tool = null;
            a.lastLine = pick(DONE_LINES);
            push(`[${a.name}] ✅ turn terminé (${fmtTokens(a.tokens)} tokens)`);
          } else if (Math.random() < 0.01) {
            a.status = 'error';
            a.tool = null;
            push(`[${a.name}] ⚠ erreur agent`);
          } else if (Math.random() < 0.1) {
            const label = pick(BG_LABELS);
            bgRef.current = [...bgRef.current.slice(-5), { id: `bg${now}${a.id}`, agentId: a.id, label, expiresAt: now + 7000 + Math.random() * 6000 }];
            push(`[${a.name}] ⚙ bg task lancée : ${label}`);
          }
        } else if (a.status === 'active') {
          if (Math.random() < 0.09) {
            a.status = 'thinking';
            a.tokens = 0;
            a.tool = pick(TOOLS);
            push(`[${a.name}] 💭 nouveau turn`);
          }
        } else if (a.status === 'sleeping') {
          if (Math.random() < 0.02) {
            a.status = 'thinking';
            a.tokens = 0;
            a.tool = pick(TOOLS);
            push(`[${a.name}] ⏰ session résumée`);
          }
        } else if (a.status === 'error') {
          if (Math.random() < 0.06) {
            a.status = 'thinking';
            a.tool = pick(TOOLS);
            push(`[${a.name}] ↻ reprise après erreur`);
          }
        }
      }
      setAgents(agentsRef.current.map(a => ({ ...a })));
      setBgTasks([...bgRef.current]);
      setEvents([...eventsRef.current]);
    }, 1400);
    return () => clearInterval(iv);
  }, []);

  return { agents, events, bgTasks };
}
