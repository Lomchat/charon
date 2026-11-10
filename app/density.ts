export type Density = 'default' | 'small';
/** A fresh install shows the small size; hubs that predate it carry an
 * explicit 'default' row (drizzle 0056), so an upgrade changes nothing. */
export const DEFAULT_DENSITY: Density = 'small';

export function isDensity(value: unknown): value is Density {
  return value === 'default' || value === 'small';
}

export function resolveDensity(value: unknown): Density {
  return isDensity(value) ? value : DEFAULT_DENSITY;
}

export function currentDensity(): Density {
  return typeof document === 'undefined'
    ? DEFAULT_DENSITY
    : resolveDensity(document.documentElement.dataset.density);
}

export function applyDensity(value: unknown): void {
  document.documentElement.dataset.density = resolveDensity(value);
}
