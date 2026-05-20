'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// Detects a mobile screen (width < 768px OR coarse pointer) at mount and
// offers the /m version. Auto-skipped on /m, /login, /logout.
// Refusal is remembered in localStorage — no spam on every visit.

const DISMISS_KEY = 'charon.mobileRedirect.dismissed';

export default function MobileRedirectPrompt() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Skip on mobile routes + auth
    if (pathname.startsWith('/m') || pathname.startsWith('/login') || pathname.startsWith('/logout')) return;
    // Skip if the user has already said no
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {}
    // Detection: width < 768px OR coarse pointer (touch-only) on a small screen
    if (typeof window === 'undefined') return;
    const isNarrow = window.matchMedia('(max-width: 768px)').matches;
    const isTouch  = window.matchMedia('(pointer: coarse)').matches;
    if (isNarrow || (isTouch && window.innerWidth < 1024)) {
      // Small delay to avoid blocking the first paint
      const t = setTimeout(() => setShow(true), 250);
      return () => clearTimeout(t);
    }
  }, [pathname]);

  if (!show) return null;

  function accept() {
    setShow(false);
    router.push('/m');
  }
  function decline() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
    setShow(false);
  }

  return (
    <div className="m-prompt-bg" onClick={decline} role="dialog" aria-modal="true">
      <div className="m-prompt-card" onClick={(e) => e.stopPropagation()}>
        <div className="m-prompt-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="6" y="2" width="12" height="20" rx="2.5" />
            <line x1="11" y1="18" x2="13" y2="18" strokeLinecap="round" />
          </svg>
        </div>
        <h2>Mobile version available</h2>
        <p>
          This interface is optimized for mobile.<br />
          Would you like to go there?
        </p>
        <div className="m-prompt-actions">
          <button type="button" className="decline" onClick={decline}>
            No, keep desktop
          </button>
          <button type="button" className="accept" onClick={accept} autoFocus>
            Yes, mobile version
          </button>
        </div>
        <p className="m-prompt-note">You can always go there from the URL <code>/m</code></p>
      </div>
    </div>
  );
}
