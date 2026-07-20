'use client';
// TEMP prototype v2 — « salle des machines » 3D en react-three-fiber.
// Noyau = Charon, pads = VPSes, robots = sessions Claude.
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { Grid, Html, Line, OrbitControls, Stars, Text } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { fmtTokens, STATUS_COLOR, useMockFleet, VPSES, type MockAgent, type MockVps } from '../mock';
import { AgentPanel, EventTicker, ProtoBanner } from '../ProtoChrome';

const PAD_POS: [number, number, number][] = VPSES.map((_, i) => {
  const a = (Math.PI * 2 * i) / 3 + Math.PI / 2;
  return [Math.cos(a) * 6.2, 0, Math.sin(a) * 6.2];
});

function CharonCore({ busy }: { busy: boolean }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (g.current) {
      g.current.rotation.y += dt * 0.5;
      g.current.rotation.x += dt * 0.16;
    }
  });
  return (
    <group position={[0, 1.7, 0]}>
      <group ref={g}>
        <mesh>
          <icosahedronGeometry args={[0.85, 0]} />
          <meshStandardMaterial color="#7c5cff" wireframe emissive="#7c5cff" emissiveIntensity={1.3} />
        </mesh>
        <mesh>
          <icosahedronGeometry args={[0.42, 1]} />
          <meshStandardMaterial color="#b9a8ff" emissive="#8f7bff" emissiveIntensity={2.1} />
        </mesh>
      </group>
      <Text position={[0, 1.35, 0]} fontSize={0.34} color="#cfd6f4" letterSpacing={0.25} anchorX="center">
        CHARON
      </Text>
      <pointLight color="#7c5cff" intensity={busy ? 30 : 14} distance={10} />
    </group>
  );
}

function Beam({ to, color, busy }: { to: [number, number, number]; color: string; busy: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (m?.material) m.material.opacity = busy ? 0.4 + Math.sin(clock.elapsedTime * 4) * 0.22 : 0.1;
  });
  return (
    <Line
      ref={ref}
      points={[[0, 1.6, 0], [to[0], 0.35, to[2]]]}
      color={color}
      lineWidth={1.4}
      transparent
      opacity={0.2}
    />
  );
}

function AgentBot({ agent, pos, selected, onSelect }: {
  agent: MockAgent;
  pos: [number, number, number];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.MeshStandardMaterial>(null);
  const orbit = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const gr = g.current;
    if (!gr) return;
    const bob = agent.status === 'thinking' ? Math.sin(t * 2.4 + phase) * 0.09 + 0.06 : 0;
    const jit = agent.status === 'error' ? Math.sin(t * 43 + phase) * 0.03 : 0;
    gr.position.set(pos[0] + jit, pos[1] + bob, pos[2]);
    gr.scale.setScalar(agent.status === 'sleeping' ? 0.82 : 1);
    if (body.current) {
      body.current.emissive.set(STATUS_COLOR[agent.status]);
      body.current.emissiveIntensity =
        agent.status === 'thinking' ? 0.55 + Math.sin(t * 3 + phase) * 0.35
        : agent.status === 'error' ? 0.6 + Math.abs(Math.sin(t * 8)) * 0.8
        : agent.status === 'active' ? 0.35
        : 0.06;
    }
    if (orbit.current) {
      orbit.current.visible = agent.status === 'thinking';
      orbit.current.rotation.y = t * 2.2 + phase;
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(agent.id);
  };

  return (
    <group ref={g} position={pos} onClick={click}>
      <mesh position={[0, 0.55, 0]} castShadow>
        <capsuleGeometry args={[0.26, 0.5, 6, 14]} />
        <meshStandardMaterial ref={body} color={agent.color} />
      </mesh>
      <mesh position={[0, 1.06, 0]}>
        <sphereGeometry args={[0.21, 18, 14]} />
        <meshStandardMaterial color="#1b2340" />
      </mesh>
      <mesh position={[0, 1.07, 0.15]}>
        <boxGeometry args={[0.24, 0.07, 0.1]} />
        <meshStandardMaterial color={STATUS_COLOR[agent.status]} emissive={STATUS_COLOR[agent.status]} emissiveIntensity={1.6} />
      </mesh>
      <group ref={orbit} position={[0, 1.3, 0]}>
        {[0, 1, 2].map(k => (
          <mesh key={k} position={[Math.cos((k * Math.PI * 2) / 3) * 0.42, 0, Math.sin((k * Math.PI * 2) / 3) * 0.42]}>
            <sphereGeometry args={[0.045, 8, 8]} />
            <meshStandardMaterial color="#cfe0ff" emissive="#9db8ff" emissiveIntensity={2} />
          </mesh>
        ))}
      </group>
      {selected && (
        <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.5, 0.03, 8, 32]} />
          <meshStandardMaterial color="#ffd24a" emissive="#ffd24a" emissiveIntensity={1.5} />
        </mesh>
      )}
      <Html position={[0, 1.72, 0]} center distanceFactor={9} zIndexRange={[40, 0]} style={{ pointerEvents: 'auto' }}>
        <div className="p2-chip" onClick={() => onSelect(agent.id)}>
          <div className="row">
            <span className="dot" style={{ background: STATUS_COLOR[agent.status] }} />
            {agent.name}
          </div>
          {agent.status === 'thinking' && agent.tool && <div className="tool">⚙ {agent.tool}</div>}
          {agent.status === 'thinking' && (
            <div className="tok">
              <span>↑ {fmtTokens(agent.tokens)}</span>
              <span className="bar"><i style={{ width: `${Math.min(100, agent.tokens / 600)}%` }} /></span>
            </div>
          )}
          {agent.status === 'sleeping' && <div className="tool" style={{ color: '#64748b' }}>💤 en veille</div>}
          {agent.status === 'error' && <div className="tool" style={{ color: '#ff4d5e' }}>⚠ erreur agent</div>}
        </div>
      </Html>
    </group>
  );
}

function VpsPad({ vps, pos, agents, selId, onSelect }: {
  vps: MockVps;
  pos: [number, number, number];
  agents: MockAgent[];
  selId: string | null;
  onSelect: (id: string) => void;
}) {
  const busy = agents.some(a => a.status === 'thinking');
  const ring = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (ring.current) {
      ring.current.emissiveIntensity = busy ? 1.2 + Math.sin(clock.elapsedTime * 3) * 0.6 : 0.45;
    }
  });
  const n = Math.max(1, agents.length);
  const slot = (j: number): [number, number, number] => {
    const th = (Math.PI * 2 * j) / n + Math.PI / 2.4;
    return [Math.cos(th) * 1.2, 0.18, Math.sin(th) * 1.2];
  };
  return (
    <group position={pos}>
      <mesh position={[0, 0.09, 0]} receiveShadow>
        <cylinderGeometry args={[2.3, 2.5, 0.18, 40]} />
        <meshStandardMaterial color="#141b33" />
      </mesh>
      <mesh position={[0, 0.19, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.3, 0.045, 10, 60]} />
        <meshStandardMaterial ref={ring} color={vps.color} emissive={vps.color} emissiveIntensity={0.8} />
      </mesh>
      <Text position={[0, 0.02, 3.1]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.44} color={vps.color} anchorX="center" fontWeight={700}>
        {vps.name}
      </Text>
      <Text position={[0, 0.02, 3.6]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.2} color="#8fa0c9" anchorX="center">
        {vps.ip} · {agents.length} session{agents.length > 1 ? 's' : ''}
      </Text>
      <pointLight color={vps.color} intensity={busy ? 14 : 6} distance={7} position={[0, 2.2, 0]} />
      {agents.map((a, j) => (
        <AgentBot key={a.id} agent={a} pos={slot(j)} selected={a.id === selId} onSelect={onSelect} />
      ))}
    </group>
  );
}

function FleetScene({ agents, selId, onSelect }: {
  agents: MockAgent[];
  selId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <color attach="background" args={['#0a0e1a']} />
      <fog attach="fog" args={['#0a0e1a', 15, 42]} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[6, 12, 4]}
        intensity={1.1}
        castShadow
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-camera-near={1}
        shadow-camera-far={30}
      />
      <Stars radius={90} depth={40} count={2200} factor={4} saturation={0} fade speed={0.5} />
      <Grid
        position={[0, 0, 0]}
        args={[60, 60]}
        cellSize={0.9}
        cellThickness={0.6}
        cellColor="#1b2743"
        sectionSize={4.5}
        sectionThickness={1}
        sectionColor="#26355c"
        fadeDistance={36}
        fadeStrength={1.6}
        infiniteGrid
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <shadowMaterial transparent opacity={0.32} />
      </mesh>
      <CharonCore busy={agents.some(a => a.status === 'thinking')} />
      {VPSES.map((v, i) => (
        <Beam key={v.id} to={PAD_POS[i]} color={v.color} busy={agents.some(a => a.vpsId === v.id && a.status === 'thinking')} />
      ))}
      {VPSES.map((v, i) => (
        <VpsPad key={v.id} vps={v} pos={PAD_POS[i]} agents={agents.filter(a => a.vpsId === v.id)} selId={selId} onSelect={onSelect} />
      ))}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={5}
        maxDistance={26}
        maxPolarAngle={Math.PI / 2.06}
        target={[0, 0.7, 0]}
      />
    </>
  );
}

export default function Scene() {
  const { agents, events } = useMockFleet();
  const [selId, setSelId] = useState<string | null>(null);
  const sel = agents.find(a => a.id === selId) ?? null;
  return (
    <div className="proto-root">
      <Canvas shadows dpr={[1, 2]} camera={{ position: [7.5, 6.5, 11], fov: 46 }} onPointerMissed={() => setSelId(null)}>
        <FleetScene agents={agents} selId={selId} onSelect={setSelId} />
      </Canvas>
      <ProtoBanner
        v={2}
        title="Proto v2 — Salle des machines 3D (react-three-fiber)"
        sub="chaque pad = un VPS · chaque robot = une session · molette/drag pour naviguer · clic sur un robot pour lui parler"
      />
      <EventTicker events={events} />
      {sel && <AgentPanel key={sel.id} agent={sel} vps={VPSES.find(v => v.id === sel.vpsId)} onClose={() => setSelId(null)} />}
    </div>
  );
}
