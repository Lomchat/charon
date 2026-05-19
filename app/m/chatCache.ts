'use client';
// Module ré-exporté depuis `app/sessionCache.ts` (partagé desktop/mobile).
// Avant le refactor de maintenabilité (audit #1), ce fichier contenait
// l'implémentation. Il est gardé pour ne pas casser les imports historiques
// `../chatCache` dans `app/m/`. Préférer le nouveau chemin pour le code neuf.
export {
  getCached, isCacheFresh, fetchAndCache, prefetchAll, invalidate,
} from '../sessionCache';
