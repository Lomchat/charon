import { redirect } from 'next/navigation';

// Legacy mobile route. The UI is now a single responsive app at `/` (the
// separate /m mobile UI was retired — see CLAUDE.md §11). Kept as a redirect
// so old bookmarks and stale push notifications still land somewhere useful.
export default function MobileIndexRedirect() {
  redirect('/');
}
