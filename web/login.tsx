import { mount, readSeed } from './mount';
import LoginForm from '@/app/login/LoginForm';

// `/login` (server/http/pages.ts § loginPage): `next` is the sanitized path
// the visitor was going to.
const { next } = readSeed<{ next: string }>();
mount(
  <div className="auth-shell">
    <div className="auth-card">
      <h1>Charon</h1>
      <LoginForm next={next} />
    </div>
  </div>,
);
