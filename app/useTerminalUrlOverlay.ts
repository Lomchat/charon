'use client';
import { useCallback, useRef, useState } from 'react';
import { extractWrappedUrls } from './terminalUrlDetect';

// useTerminalUrlOverlay
// ─────────────────────────────────────────────────────────────────────────────
// Hook léger qui accumule du texte terminal et expose le dernier URL "long"
// détecté (typiquement un URL OAuth wrappé sur plusieurs lignes). Utilisé par
// `LoginConsole` et `ShellTerminal` pour proposer un overlay copier/ouvrir
// quand l'user ne peut pas sélectionner l'URL à la main.
//
// État interne :
//   - bufRef : rolling buffer (cap 64 KB) du texte raw reçu
//   - currentUrl : dernier URL extrait
//   - dismissedUrl : URL que l'user a explicitement masqué (clic ✕)
//
// Visible = currentUrl && currentUrl !== dismissedUrl
// Si un NOUVEL URL apparaît après un dismiss, il remplace le dismissed et
// devient visible. Comportement attendu (chaque URL est une opportunité).

const MAX_BUFFER = 64_000;

export function useTerminalUrlOverlay() {
  const bufRef = useRef<string>('');
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);

  const ingest = useCallback((text: string) => {
    // Append + cap. On garde le tail parce qu'un URL ne fait jamais > 64 KB,
    // mais on évite de garder l'historique complet d'un shell long.
    bufRef.current = (bufRef.current + text).slice(-MAX_BUFFER);
    const urls = extractWrappedUrls(bufRef.current);
    if (urls.length === 0) return;
    const latest = urls[urls.length - 1];
    setCurrentUrl((prev) => (prev === latest ? prev : latest));
  }, []);

  const dismiss = useCallback(() => {
    setDismissedUrl(currentUrl);
  }, [currentUrl]);

  const reset = useCallback(() => {
    bufRef.current = '';
    setCurrentUrl(null);
    setDismissedUrl(null);
  }, []);

  const visibleUrl = currentUrl && currentUrl !== dismissedUrl ? currentUrl : null;

  return { ingest, dismiss, reset, visibleUrl };
}
