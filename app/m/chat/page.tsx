import { redirect } from 'next/navigation';
import { db, vps as vpsTable, vpsPaths as vpsPathsTable } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import MobileChat from './MobileChat';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ id?: string }>;

export default async function MobileChatPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const { id } = await searchParams;
  if (!id) redirect('/m/select');

  const vpsRows = db.select().from(vpsTable).all();
  const pathRows = db.select().from(vpsPathsTable).all();

  return <MobileChat sessionId={id} vpsList={vpsRows} vpsPaths={pathRows} />;
}
