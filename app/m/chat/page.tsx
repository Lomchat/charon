import { redirect } from 'next/navigation';
import { db, vps as vpsTable, vpsPaths as vpsPathsTable } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import MobileChat from './MobileChat';
import SessionErrorBoundary from '../../SessionErrorBoundary';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ id?: string }>;

export default async function MobileChatPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const { id } = await searchParams;
  if (!id) redirect('/m/select');

  const vpsRows = db.select().from(vpsTable).all();
  const pathRows = db.select().from(vpsPathsTable).all();

  // Auto-recovering boundary: a render error in the chat must not freeze
  // it permanently (the polling/SSE effects live inside MobileChat — they
  // die on unmount). The boundary remounts after ~1.5s. cf. CLAUDE.md §14.
  return (
    <SessionErrorBoundary resetKey={id}>
      <MobileChat sessionId={id} vpsList={vpsRows} vpsPaths={pathRows} />
    </SessionErrorBoundary>
  );
}
