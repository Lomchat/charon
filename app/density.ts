export const DEFAULT_DENSITY = 'default';
export type Density = 'default' | 'small';

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
