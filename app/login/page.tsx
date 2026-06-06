import { sanitizeNextPath } from '@/lib/nextPath';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

// Server component: reads the ?next=… target (set by middleware when it
// redirects an unauthenticated request) and hands the sanitized path to the
// client form as a hidden field. After login, `loginAction` redirects there
// so a mobile user logged-out by inactivity returns to /m/... rather than the
// desktop "/" UI.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = sanitizeNextPath(next);

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Charon</h1>
        <LoginForm next={safeNext} />
      </div>
    </div>
  );
}
