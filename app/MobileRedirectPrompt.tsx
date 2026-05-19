'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// Détecte un écran mobile (largeur < 768px OU pointer coarse) au mount et
// propose la version /m. Skip auto sur /m, /login, /logout.
// Le refus est mémorisé dans localStorage — pas de spam à chaque visite.

const DISMISS_KEY = 'charon.mobileRedirect.dismissed';

export default function MobileRedirectPrompt() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Skip sur routes mobile + auth
    if (pathname.startsWith('/m') || pathname.startsWith('/login') || pathname.startsWith('/logout')) return;
    // Skip si l'utilisateur a déjà dit non
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {}
    // Détection : largeur < 768px OU pointer grossier (touch-only) sur petit écran
    if (typeof window === 'undefined') return;
    const isNarrow = window.matchMedia('(max-width: 768px)').matches;
    const isTouch  = window.matchMedia('(pointer: coarse)').matches;
    if (isNarrow || (isTouch && window.innerWidth < 1024)) {
      // Petit délai pour éviter de bloquer le first paint
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
        <h2>Version mobile disponible</h2>
        <p>
          Cette interface est optimisée pour mobile.<br />
          Veux-tu y aller ?
        </p>
        <div className="m-prompt-actions">
          <button type="button" className="decline" onClick={decline}>
            Non, garder desktop
          </button>
          <button type="button" className="accept" onClick={accept} autoFocus>
            Oui, version mobile
          </button>
        </div>
        <p className="m-prompt-note">Tu peux toujours y aller depuis l'URL <code>/m</code></p>
      </div>
    </div>
  );
}
