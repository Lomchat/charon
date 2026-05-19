'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import ShellTerminal from '@/app/ShellTerminal';

type ShellMeta = {
  id: string;
  vpsId: string;
  vpsName: string;
  cwd: string | null;
  name: string | null;
};

export default function MobileShell({ shellId }: { shellId: string }) {
  const router = useRouter();
  const [meta, setMeta] = useState<ShellMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.listShells();
        const sh = (r?.shells ?? []).find((s: any) => s.id === shellId);
        if (!cancelled) {
          if (sh) setMeta(sh);
          else setError('shell introuvable');
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [shellId]);

  return (
    <>
      <header className="m-topbar">
        <button className="m-back" onClick={() => router.push('/m/select')} aria-label="retour">←</button>
        <div className="m-title-block">
          <span className="m-title">{meta?.name ?? 'shell'}</span>
          <span className="m-subtitle">
            {meta ? `${meta.vpsName}:${meta.cwd ?? '~'}` : (error ?? '…')}
          </span>
        </div>
      </header>
      <div className="m-shell-page">
        <div className="m-shell-container">
          {meta ? (
            <ShellTerminal
              shellId={meta.id}
              vpsName={meta.vpsName}
              cwd={meta.cwd}
              onKilled={() => router.push('/m/select')}
            />
          ) : (
            <div style={{ padding: 24, color: 'var(--parchment-soft)' }}>
              {error ?? 'chargement…'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
