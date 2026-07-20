'use client';
// TEMP prototype — /v3 React Flow (voir app/(proto)/README.md)
import dynamic from 'next/dynamic';
import '../proto.css';

const Flow = dynamic(() => import('./Flow'), {
  ssr: false,
  loading: () => <div className="proto-loading">chargement du mission control…</div>,
});

export default function V3Page() {
  return <Flow />;
}
