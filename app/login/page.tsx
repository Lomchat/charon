'use client';
import { useActionState } from 'react';
import { loginAction } from './actions';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Charon</h1>
        <form action={formAction}>
          <label>
            <span>password</span>
            <input type="password" name="password" autoComplete="current-password" required autoFocus />
          </label>
          {state?.error && <div className="err">{state.error}</div>}
          <button type="submit" disabled={pending}>{pending ? '…' : 'enter'}</button>
        </form>
      </div>
    </div>
  );
}
