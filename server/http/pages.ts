import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable } from '@/lib/db';
import { readSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { listTabs } from '@/lib/server/hub/tabs';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { latestVersionsByKey, refreshAllLatestsIfStale } from '@/lib/server/hub/sdkSync';
import { autoUpdatingVpsIds } from '@/lib/server/hub/sdkWatch';
import { ssrSummaries } from '@/lib/server/sync/ssrSummaries';
import { activitySnapshot, markWatched } from '@/lib/server/hub/sessionActivity';
import { getSetting } from '@/lib/server/hub/settings';
import { readCookie } from '@/lib/server/requestContext';
import { isAuthRequired } from '@/lib/server/authGate.js';
import { isLiveHtmlName } from '@/lib/livePreview';
import { mintLivePreview } from '@/lib/server/hub/livePreviewMint';
import { sanitizeNextPath } from '@/lib/nextPath';
import { PANEL_LAYOUT_COOKIE, parsePanelLayout } from '@/app/panelLayout';
import { parseTabFocus, projectTabFocus, TAB_FOCUS_COOKIE } from '@/app/tabFocusCookie';
import { resolveTheme } from '@/app/themes';
import { DEFAULT_DENSITY, resolveDensity } from '@/app/density';
import { DEFAULT_FILE_ICONS, resolveFileIcons } from '@/app/fileIconStyle';
import { hasStandaloneView } from '@/app/fileViews';

// The pages: each one is a Vite HTML entry (web/<name>.html) that the server
// fills per request — the theme on <html> (flash-free, §11), the <title> and
// theme-color, and the page's first data as JSON (`#charon-seed`), read by
// web/<name>.tsx. What app/*/page.tsx used to compute, unchanged.

export type PageName = 'hub' | 'desk' | 'view' | 'login';

/** The raw HTML of a page entry (prod: dist/client; dev: Vite-transformed). */
export type TemplateLoader = (name: PageName, url: string) => Promise<string>;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!
));

/** JSON safe inside a <script> element: no `</script>`, no line separators. */
const scriptJson = (v: unknown) => JSON.stringify(v ?? null)
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function htmlAttributes(): { theme: ReturnType<typeof resolveTheme>; attrs: string } {
  // A settings read must never take a page down: defaults on any failure.
  let theme = resolveTheme(null);
  try { theme = resolveTheme(getSetting('app.theme')); } catch { /* default */ }
  let density: string = DEFAULT_DENSITY;
  try { density = resolveDensity(getSetting('app.density')); } catch { /* default */ }
  let icons: string = DEFAULT_FILE_ICONS;
  try { icons = resolveFileIcons(getSetting('app.file_icons')); } catch { /* default */ }
  const attrs = `data-theme="${escapeHtml(theme.id)}" data-density="${escapeHtml(density)}" data-file-icons="${escapeHtml(icons)}"`;
  return { theme, attrs };
}

export async function renderPage(
  load: TemplateLoader, name: PageName, req: Request,
  opts: { title: string; seed: unknown; status?: number },
): Promise<Response> {
  const template = await load(name, new URL(req.url).pathname);
  const { theme, attrs } = htmlAttributes();
  const html = template
    .replace('data-charon-root', attrs)
    .replace('<meta name="charon-head">',
      `<title>${escapeHtml(opts.title)}</title><meta name="theme-color" content="${escapeHtml(theme.themeColor)}">`)
    .replace(
      '<script id="charon-seed" type="application/json"></script>',
      `<script id="charon-seed" type="application/json">${scriptJson(opts.seed)}</script>`,
    );
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
    },
  });
}

export function redirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { Location: location } });
}

const cookies = (req: Request) => req.headers.get('cookie');

/** `/` — the hub (app/HubPanel.tsx). */
export async function hubPage(load: TemplateLoader, req: Request): Promise<Response> {
  if (!(await readSession())) return redirect('/login');
  seedInitialData();
  // Folders by position (persistent drag-and-drop); VPSes by position within
  // their folder — the sidebar groups by folderId and keeps this order.
  const vpsFolders = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt)).all();
  const vpsList = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();
  const vpsPaths = db.select().from(vpsPathsTable).all();
  // The session summaries (§14.108) stamped with the bus revision read in the
  // same synchronous section: the first SSE connect resumes from it.
  const { summaries, sync } = ssrSummaries();
  const staleness = { ...latestVersionsByKey(), autoUpdatingVpsIds: autoUpdatingVpsIds() };
  refreshAllLatestsIfStale();
  // This browser's focused tab (cookie), and its column widths/folds.
  const initialTabs = projectTabFocus(listTabs(), parseTabFocus(readCookie(cookies(req), TAB_FOCUS_COOKIE) ?? undefined));
  const initialPanels = parsePanelLayout(readCookie(cookies(req), PANEL_LAYOUT_COOKIE) ?? undefined);
  return renderPage(load, 'hub', req, {
    title: 'Charon',
    seed: {
      vpsList, vpsFolders, vpsPaths,
      initialSessions: summaries, initialSummaries: summaries, initialSync: sync,
      builtPyzSha: getBuiltPyzSha(), builtAgentVersion: getBuiltAgentVersion(),
      staleness, initialTabs, initialPanels,
    },
  });
}

/** `/desk` — the fleet as a game board (app/desk/Desk.tsx), same reads as `/`
 *  plus what each session is doing right now (sessionActivity.ts). */
export async function deskPage(load: TemplateLoader, req: Request): Promise<Response> {
  if (!(await readSession())) return redirect('/login');
  seedInitialData();
  const folders = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt)).all();
  const vpsList = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();
  const vpsPaths = db.select().from(vpsPathsTable).all();
  const { summaries, sync } = ssrSummaries();
  markWatched();
  return renderPage(load, 'desk', req, {
    title: 'The desk — Charon',
    seed: {
      vpsList, folders, vpsPaths, initialSummaries: summaries, initialSync: sync,
      initialActivity: activitySnapshot(),
    },
  });
}

/** `/view?vps=<id>&root=<abs>&path=<rel>` — one file, full window
 *  (`fileViews.ts § standaloneViewUrl`); an HTML file goes to its live page,
 *  minted for THIS login (§14.110). */
export async function viewPage(load: TemplateLoader, req: Request): Promise<Response> {
  const s = await readSession();
  if (!s) return redirect('/login');
  const sp = new URL(req.url).searchParams;
  const vpsId = sp.get('vps') ?? '';
  const root = sp.get('root') ?? '';
  const path = sp.get('path') ?? '';
  // `code=1`: the file's text, read-only, through the same fs route as the pane
  // (this page reads nothing itself). Absent ⇒ every answer is as before.
  const code = sp.get('code') === '1';
  const lineN = Number(sp.get('line'));
  const line = Number.isSafeInteger(lineN) && lineN > 0 ? lineN : undefined;
  const name = path.split('/').pop() || path;
  const title = name ? `${name} — Charon` : 'Charon';
  const refuse = (refusal: string) => renderPage(load, 'view', req, { title, seed: { refusal } });
  if (!vpsId || !root.startsWith('/') || root.length > 4096 || !path || path.length > 4096) {
    return refuse('this link does not name a file');
  }
  const [v] = db.select({ id: vpsTable.id }).from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) return refuse('this VPS is no longer in Charon');
  if (!code && isLiveHtmlName(path)) {
    const m = mintLivePreview(vpsId, root, path, s.sessionId);
    return m.ok ? redirect(m.url) : refuse(m.error);
  }
  if (code) return renderPage(load, 'view', req, { title, seed: { vpsId, root, path, code: true, ...(line ? { line } : {}) } });
  if (!hasStandaloneView(name)) return refuse('this file has no rendered view — open it in Charon');
  return renderPage(load, 'view', req, { title, seed: { vpsId, root, path } });
}

/** `/login` — the form (web/login.tsx). No password on this hub (§12): no
 *  form; the page sends the visitor where it was going. */
export async function loginPage(load: TemplateLoader, req: Request): Promise<Response> {
  const next = sanitizeNextPath(new URL(req.url).searchParams.get('next'));
  if (!isAuthRequired()) return redirect(next);
  return renderPage(load, 'login', req, { title: 'Charon', seed: { next } });
}

/** The retired mobile routes: old bookmarks and stale notifications. */
export function mobileRedirect(req: Request): Response {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (url.pathname === '/m/chat' && id) return redirect(`/?session=${encodeURIComponent(id)}`);
  if (url.pathname === '/m/shell' && id) return redirect(`/?shell=${encodeURIComponent(id)}`);
  return redirect('/');
}
