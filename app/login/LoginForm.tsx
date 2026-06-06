'use client';
import { useActionState } from 'react';
import { loginAction } from './actions';

// Client form for the login page. `next` is the sanitized post-login redirect
// target (computed server-side in page.tsx from ?next=…) and is carried as a
// hidden field so it survives the server-action POST. It stays stable across a
// failed attempt because it's a prop captured at render time.
export default function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <form action={formAction}>
      <input type="hidden" name="next" value={next} />
      <label>
        <span>password</span>
        <input type="password" name="password" autoComplete="current-password" required autoFocus />
      </label>
      {state?.error && <div className="err">{state.error}</div>}
      <button type="submit" disabled={pending}>{pending ? '…' : 'enter'}</button>
    </form>
  );
}
