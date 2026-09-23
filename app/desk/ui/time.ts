// L'heure relative, côté React.
//
// `hall/canvas.js` a la sienne, et c'est la même — mais la salle est du
// JavaScript que `tsc` ne lit pas, et React ne peut pas l'importer sans
// traîner Three.js dans son typage. Huit lignes de duplication valent mieux
// qu'une frontière de plus. Les deux disent la même chose, dans les mêmes
// mots : c'est la seule chose à tenir.

/** « 4 min ago » — en anglais, sans dépendance. */
export function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
