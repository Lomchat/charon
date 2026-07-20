'use client';
// TEMP prototype — /v2 react-three-fiber (voir app/(proto)/README.md)
import dynamic from 'next/dynamic';
import '../proto.css';

const Scene = dynamic(() => import('./Scene'), {
  ssr: false,
  loading: () => <div className="proto-loading">chargement de la scène 3D…</div>,
});

export default function V2Page() {
  return <Scene />;
}
