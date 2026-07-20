'use client';
// TEMP prototype — /v1 Claudeville (voir app/(proto)/README.md)
import dynamic from 'next/dynamic';
import '../proto.css';

const Village = dynamic(() => import('./Village'), {
  ssr: false,
  loading: () => <div className="proto-loading">chargement du village…</div>,
});

export default function V1Page() {
  return <Village />;
}
