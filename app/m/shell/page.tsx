import { redirect } from 'next/navigation';

// Legacy mobile shell route → unified responsive `/?shell=<id>` (CLAUDE.md
// §11). The old route used `?id=`; the unified panel deep-links via `?shell=`.
type SearchParams = Promise<{ id?: string }>;

export default async function MobileShellRedirect({ searchParams }: { searchParams: SearchParams }) {
  const { id } = await searchParams;
  redirect(id ? `/?shell=${encodeURIComponent(id)}` : '/');
}
