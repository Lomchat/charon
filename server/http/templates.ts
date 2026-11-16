import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { PageName, TemplateLoader } from './pages';

/** Production: the built entries (dist/client/web/<name>.html), read once. */
export function prodTemplates(clientDir: string): TemplateLoader {
  const cache = new Map<PageName, string>();
  return async (name) => {
    let html = cache.get(name);
    if (html == null) {
      html = fs.readFileSync(path.join(clientDir, 'web', `${name}.html`), 'utf8');
      cache.set(name, html);
    }
    return html;
  };
}

/** Development: the source entries through Vite (HMR client, module paths). */
export function devTemplates(
  vite: { transformIndexHtml(url: string, html: string): Promise<string> }, rootDir: string,
): TemplateLoader {
  return async (name, url) => {
    const html = fs.readFileSync(path.join(rootDir, 'web', `${name}.html`), 'utf8');
    return vite.transformIndexHtml(url, html);
  };
}
