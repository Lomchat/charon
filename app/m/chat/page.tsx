import { redirect } from 'next/navigation';

// Legacy mobile chat route → unified responsive `/?session=<id>` (CLAUDE.md
// §11). The old route used `?id=`; the unified panel deep-links via `?session=`.
type SearchParams = Promise<{ id?: string }>;

export default async function MobileChatRedirect({ searchParams }: { searchParams: SearchParams }) {
  const { id } = await searchParams;
  redirect(id ? `/?session=${encodeURIComponent(id)}` : '/');
}
