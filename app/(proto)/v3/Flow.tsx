'use client';
// TEMP prototype v3 — « mission control » : graphe vivant en React Flow.
// Hub → VPS (groupes) → agents (cartes) ; bg tasks éphémères en nœuds pointillés.
import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { fmtTokens, STATUS_COLOR, STATUS_LABEL, useMockFleet, VPSES, type MockAgent, type MockBgTask, type MockVps } from '../mock';
import { AgentPanel, EventTicker, ProtoBanner } from '../ProtoChrome';

function CharonNode() {
  return (
    <div className="p3-charon">
      <b>⚡ CHARON</b>
      <span>hub · SSE live · {VPSES.length} VPS · 7 agents</span>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

function VpsNode({ data }: NodeProps) {
  const d = data as unknown as { vps: MockVps; busy: boolean; count: number };
  return (
    <div
      className="p3-vps"
      style={d.busy ? { borderColor: d.vps.color, boxShadow: `0 0 18px ${d.vps.color}33` } : undefined}
    >
      <header>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: d.vps.color, display: 'inline-block', flex: 'none' }} />
        {d.vps.name}
        <span className="ip">{d.vps.ip} · {d.count} sessions</span>
      </header>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
    </div>
  );
}

function AgentNode({ data }: NodeProps) {
  const d = data as unknown as { agent: MockAgent; sel: boolean };
  const a = d.agent;
  return (
    <div className={`p3-agent ${a.status}${d.sel ? ' sel' : ''}`}>
      <div className="top">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, display: 'inline-block', flex: 'none' }} />
        {a.name}
        <span className="st" style={{ background: STATUS_COLOR[a.status] }}>{STATUS_LABEL[a.status]}</span>
      </div>
      <div className="tool">
        {a.status === 'thinking' && a.tool ? `⚙ ${a.tool}`
          : a.status === 'sleeping' ? '💤 session en veille'
          : a.status === 'error' ? '⚠ agent en erreur'
          : `✓ ${a.lastLine.slice(0, 40)}`}
      </div>
      <div className="foot">
        <span>↑ {fmtTokens(a.tokens)}</span>
        <span className="prog"><i style={{ width: `${(a.todosDone / Math.max(1, a.todosTotal)) * 100}%` }} /></span>
        <span>{a.todosDone}/{a.todosTotal}</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

function BgNode({ data }: NodeProps) {
  const d = data as unknown as { label: string };
  return (
    <div className="p3-bg">
      ⚙ bg task : {d.label}
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { charon: CharonNode, vps: VpsNode, agent: AgentNode, bg: BgNode };

const COL_W = 340;
const GRP_X0 = 30;
const GRP_Y = 200;
const AG_H = 96;

function buildNodes(agents: MockAgent[], bgTasks: MockBgTask[], selId: string | null): Node[] {
  const nodes: Node[] = [
    { id: 'charon', type: 'charon', position: { x: GRP_X0 + COL_W + 145 - 118, y: 20 }, data: {} },
  ];
  VPSES.forEach((v, i) => {
    const list = agents.filter(a => a.vpsId === v.id);
    const h = 50 + list.length * AG_H;
    nodes.push({
      id: v.id,
      type: 'vps',
      position: { x: GRP_X0 + i * COL_W, y: GRP_Y },
      data: { vps: v, busy: list.some(a => a.status === 'thinking'), count: list.length },
      style: { width: 290, height: h },
      selectable: false,
    });
    list.forEach((a, j) => {
      nodes.push({
        id: a.id,
        type: 'agent',
        parentId: v.id,
        extent: 'parent',
        position: { x: 13, y: 46 + j * AG_H },
        data: { agent: a, sel: a.id === selId },
      });
    });
    const myBg = bgTasks.filter(t => list.some(a => a.id === t.agentId));
    myBg.forEach((t, k) => {
      nodes.push({
        id: t.id,
        type: 'bg',
        position: { x: GRP_X0 + i * COL_W + 62, y: GRP_Y + h + 22 + k * 48 },
        data: { label: t.label },
      });
    });
  });
  return nodes;
}

function buildEdges(agents: MockAgent[], bgTasks: MockBgTask[]): Edge[] {
  const edges: Edge[] = VPSES.map(v => ({
    id: `e-${v.id}`,
    source: 'charon',
    target: v.id,
    type: 'smoothstep',
    animated: agents.some(a => a.vpsId === v.id && a.status === 'thinking'),
    style: { stroke: v.color, strokeWidth: 1.6, opacity: 0.85 },
  }));
  for (const t of bgTasks) {
    edges.push({
      id: `e-${t.id}`,
      source: t.agentId,
      target: t.id,
      animated: true,
      style: { stroke: '#ffb454', strokeWidth: 1.2, strokeDasharray: '5 4' },
    });
  }
  return edges;
}

export default function Flow() {
  const { agents, events, bgTasks } = useMockFleet();
  const [selId, setSelId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(buildNodes(agents, bgTasks, selId));

  useEffect(() => {
    setNodes(prev =>
      buildNodes(agents, bgTasks, selId).map(n => {
        const old = prev.find(p => p.id === n.id);
        return old ? { ...n, position: old.position } : n;
      })
    );
  }, [agents, bgTasks, selId, setNodes]);

  const edges = useMemo(() => buildEdges(agents, bgTasks), [agents, bgTasks]);
  const sel = agents.find(a => a.id === selId) ?? null;

  return (
    <div className="proto-root">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        onNodeClick={(_, n) => { if (n.type === 'agent') setSelId(n.id); }}
        onPaneClick={() => setSelId(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#1e2947" />
        <MiniMap
          pannable
          zoomable
          style={{ background: '#0d1222' }}
          maskColor="rgba(6,9,18,.75)"
          nodeColor={n =>
            n.type === 'agent'
              ? STATUS_COLOR[((n.data as { agent?: MockAgent }).agent?.status) ?? 'sleeping']
              : n.type === 'vps' ? '#1c2540' : '#7c5cff'
          }
        />
        <Controls showInteractive={false} />
      </ReactFlow>
      <ProtoBanner
        v={3}
        title="Proto v3 — Mission control (React Flow)"
        sub="graphe vivant : hub → VPS → agents · bg tasks éphémères en pointillés · tout est déplaçable · clic sur un agent"
      />
      <EventTicker events={events} />
      {sel && <AgentPanel key={sel.id} agent={sel} vps={VPSES.find(v => v.id === sel.vpsId)} onClose={() => setSelId(null)} />}
    </div>
  );
}
