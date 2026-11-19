'use client';
import dynamic from './dynamic';
import { closeAccountResets, useAccountResetsTarget } from './resetsStore';

const ResetsModal = dynamic(() => import('./ResetsModal'), { ssr: false });

/** THE resets modal of a page (§14.126): mounted once per page (hub, desk),
 *  opened from any surface through `openAccountResets`. */
export default function ResetsModalHost() {
  const accountId = useAccountResetsTarget();
  if (!accountId) return null;
  return <ResetsModal key={accountId} accountId={accountId} onClose={closeAccountResets} />;
}
