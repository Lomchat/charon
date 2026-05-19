import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/server/session';
import MobileShell from './MobileShell';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ id?: string }>;

export default async function MobileShellPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const { id } = await searchParams;
  if (!id) redirect('/m/select');

  return <MobileShell shellId={id} />;
}
