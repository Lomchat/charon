'use client';
import { useState } from 'react';

type Props = {
  url: string;
  onDismiss: () => void;
};

/**
 * Small floating overlay at the bottom of the terminal when a long URL
 * has been detected (probably wrapped across multiple lines by hard-wrap
 * or soft-wrap). Buttons: copy (clipboard), open (new tab), hide.
 *
 * Designed to sit on any `position: relative` container (LoginConsole
 * and ShellTerminal set their xterm-container that way).
 */
export default function TerminalUrlOverlay({ url, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select into an invisible textarea and exec copy
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {}
    }
  };

  const onOpen = () => {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {}
  };

  // Truncated display: start + … + end so the user visually recognizes it
  // (claude.com/cai/oauth) and the end (the `state=...`).
  const display = url.length > 90 ? url.slice(0, 55) + '…' + url.slice(-30) : url;

  return (
    <div className="term-url-overlay" role="region" aria-label="URL detected in terminal">
      <div className="term-url-head">
        <span className="term-url-glyph">🔗</span>
        <span className="term-url-title">URL detected</span>
        <span className="term-url-hint">probably wrapped across multiple lines</span>
        <button
          type="button"
          className="term-url-dismiss"
          onClick={onDismiss}
          title="hide"
          aria-label="hide"
        >✕</button>
      </div>
      <div className="term-url-display" title={url}>{display}</div>
      <div className="term-url-actions">
        <button
          type="button"
          className="term-url-btn"
          onClick={onCopy}
          title="copy the full URL to clipboard"
        >{copied ? '✓ copied' : '📋 copy'}</button>
        <button
          type="button"
          className="term-url-btn primary"
          onClick={onOpen}
          title="open the URL in a new tab"
        >↗ open</button>
      </div>
    </div>
  );
}
