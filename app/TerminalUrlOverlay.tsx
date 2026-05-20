'use client';
import { useState } from 'react';

type Props = {
  url: string;
  onDismiss: () => void;
};

/**
 * Petit overlay flottant en bas du terminal quand on a détecté un URL long
 * (probablement coupé sur plusieurs lignes par hard-wrap ou soft-wrap).
 * Boutons : copier (clipboard), ouvrir (nouvel onglet), masquer.
 *
 * Conçu pour aller sur tout container `position: relative` (LoginConsole
 * et ShellTerminal posent leur xterm-container ainsi).
 */
export default function TerminalUrlOverlay({ url, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback : sélectionne dans un textarea invisible et exec copy
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

  // Affichage tronqué : début + … + fin pour que l'user reconnaisse
  // visuellement (claude.com/cai/oauth) et la fin (le `state=...`).
  const display = url.length > 90 ? url.slice(0, 55) + '…' + url.slice(-30) : url;

  return (
    <div className="term-url-overlay" role="region" aria-label="URL détecté dans le terminal">
      <div className="term-url-head">
        <span className="term-url-glyph">🔗</span>
        <span className="term-url-title">URL détecté</span>
        <span className="term-url-hint">probablement coupé sur plusieurs lignes</span>
        <button
          type="button"
          className="term-url-dismiss"
          onClick={onDismiss}
          title="masquer"
          aria-label="masquer"
        >✕</button>
      </div>
      <div className="term-url-display" title={url}>{display}</div>
      <div className="term-url-actions">
        <button
          type="button"
          className="term-url-btn"
          onClick={onCopy}
          title="copier l'URL complet dans le presse-papiers"
        >{copied ? '✓ copié' : '📋 copier'}</button>
        <button
          type="button"
          className="term-url-btn primary"
          onClick={onOpen}
          title="ouvrir l'URL dans un nouvel onglet"
        >↗ ouvrir</button>
      </div>
    </div>
  );
}
