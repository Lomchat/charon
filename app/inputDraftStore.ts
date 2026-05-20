'use client';
import { useCallback, useRef, useState } from 'react';

// In-memory store des "drafts" de la zone d'input (textarea de message à
// Claude), indexés par session id.
//
// Persistance volontairement éphémère :
//   - Map module-level → survit aux re-mounts de composant déclenchés par
//     `<ClaudeSessionView key={selectedId}>` (switch de session desktop) et
//     aux changements de route /m/select ↔ /m/chat?id=… sur mobile.
//   - Pas de localStorage / sessionStorage → un F5 vide tout. C'est le
//     comportement attendu (cf. demande user) : on garde le brouillon le
//     temps de naviguer entre sessions, pas plus.
//
// Consommé par `app/ClaudeSessionView.tsx` (desktop) et
// `app/m/chat/MobileChat.tsx` (mobile) via le hook `useInputDraft`.

const drafts = new Map<string, string>();

export function getDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? '';
}

export function setDraft(sessionId: string, value: string): void {
  // Vider la chaîne ⇒ supprime l'entrée (évite que le Map grossisse
  // indéfiniment quand l'user envoie son message ou efface tout).
  if (value) drafts.set(sessionId, value);
  else drafts.delete(sessionId);
}

export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}

/**
 * Hook React qui expose `[input, setInput]` comme un `useState` classique,
 * mais branché sur le store partagé.
 *
 * - Initialisation lazy depuis le store → pas de flash d'input vide au mount.
 * - Réconciliation en render quand `sessionId` change sur le même composant
 *   (cas mobile : `/m/chat?id=A` → `/m/chat?id=B` ne remount pas la page,
 *    on doit donc resynchroniser via une comparaison ref vs prop, pattern
 *    "derived state from props" sans useEffect — pas de flash, pas de boucle).
 * - Chaque mutation écrit dans le store, ce qui rend transparent l'usage :
 *   les call-sites font `setInput(value)` comme avant.
 */
export function useInputDraft(sessionId: string): [string, (v: string) => void] {
  const [input, setInputState] = useState<string>(() => getDraft(sessionId));
  const lastSidRef = useRef(sessionId);
  if (lastSidRef.current !== sessionId) {
    lastSidRef.current = sessionId;
    setInputState(getDraft(sessionId));
  }
  const setInput = useCallback(
    (v: string) => {
      setInputState(v);
      setDraft(sessionId, v);
    },
    [sessionId],
  );
  return [input, setInput];
}
