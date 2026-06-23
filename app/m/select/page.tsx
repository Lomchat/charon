import { redirect } from 'next/navigation';

// Legacy mobile selection screen → unified responsive `/` (CLAUDE.md §11).
export default function MobileSelectRedirect() {
  redirect('/');
}
