'use client';
import { useState, type FormEvent } from 'react';

// The login form (web/login.tsx). `next` is the sanitized post-login target
// (server/http/pages.ts § loginPage), sent back as a hidden field; POST /login
// (server/http/login.ts) answers `{ ok, next }` with the session cookie, or
// `{ error }`.
export default function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/login', {
        method: 'POST',
        body: new FormData(e.currentTarget),
        headers: { accept: 'application/json' },
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; next?: string; error?: string } | null;
      if (body?.ok) {
        window.location.assign(body.next || '/');
        return;
      }
      setError(body?.error || `login failed (${res.status})`);
    } catch {
      setError('network error');
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit}>
      <input type="hidden" name="next" value={next} />
      <label>
        <span>password</span>
        <input type="password" name="password" autoComplete="current-password" required autoFocus />
      </label>
      {error && <div className="err">{error}</div>}
      <button type="submit" disabled={pending}>{pending ? '…' : 'enter'}</button>
    </form>
  );
}
