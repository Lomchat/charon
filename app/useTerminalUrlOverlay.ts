'use client';
import { useCallback, useRef, useState } from 'react';
import { extractWrappedUrls } from './terminalUrlDetect';

// useTerminalUrlOverlay
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight hook that accumulates terminal text and exposes the latest "long"
// URL detected (typically an OAuth URL wrapped across multiple lines). Used by
// `LoginConsole` and `ShellTerminal` to offer a copy/open overlay
// when the user cannot select the URL by hand.
//
// Internal state:
//   - bufRef: rolling buffer (cap 64 KB) of raw text received
//   - currentUrl: latest extracted URL
//   - dismissedUrl: URL the user explicitly dismissed (click ✕)
//
// Visible = currentUrl && currentUrl !== dismissedUrl
// If a NEW URL appears after a dismiss, it replaces the dismissed one and
// becomes visible. Expected behavior (each URL is an opportunity).

const MAX_BUFFER = 64_000;

// URLs never worth an overlay: long links that programs print routinely
// (they trip the length threshold but the user never needs to copy them
// from a wrapped terminal line — e.g. Claude Code citing its docs).
const IGNORED_URL_PREFIXES = ['https://code.claude.com/docs/'];

export function useTerminalUrlOverlay() {
  const bufRef = useRef<string>('');
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);

  const ingest = useCallback((text: string) => {
    // Append + cap. We keep the tail because a URL is never > 64 KB,
    // but we avoid keeping the full history of a long shell.
    bufRef.current = (bufRef.current + text).slice(-MAX_BUFFER);
    const urls = extractWrappedUrls(bufRef.current).filter(
      (u) => !IGNORED_URL_PREFIXES.some((p) => u.startsWith(p)),
    );
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
