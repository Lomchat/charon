'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Shared app-frame for the sidebar design explorations. Renders the real
// header + an empty main column so each `aside` is judged in context.
// `aside` is the version-specific sidebar; everything else is identical.
export default function LabFrame({
  aside,
  variant,
  blurb,
}: {
  aside: React.ReactNode;
  variant: string;
  blurb: string;
}) {
  const path = usePathname();
  return (
    <div className="claude-root lab-root">
      <header className="claude-head">
        <svg className="brand-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12h8M12 8v8" />
        </svg>
        <h1>CHARON</h1>
        <span className="lab-tag">design lab · {variant}</span>
        <div className="head-right">
          <nav className="lab-switch">
            {['/v1', '/v2', '/v3'].map((p) => (
              <Link key={p} href={p} className={`lab-switch-link${path === p ? ' on' : ''}`}>
                {p.slice(1)}
              </Link>
            ))}
            <Link href="/" className="lab-switch-link main">main</Link>
          </nav>
        </div>
      </header>

      {aside}

      <main className="claude-main lab-main">
        <div className="lab-main-empty">
          <div className="lab-main-icon">◐</div>
          <p className="lab-main-blurb">{blurb}</p>
          <p className="lab-main-hint">Sidebar mockup only — rows and the “new” modal are not wired up.</p>
        </div>
      </main>
    </div>
  );
}
