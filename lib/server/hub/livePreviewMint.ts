import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import {
  isLiveHtmlName, livePreviewScope, livePreviewUrl, parseLivePreviewPath,
} from '@/lib/livePreview';
import { LIVE_PREVIEW_TTL_SECS, signLivePreviewToken } from './livePreviewToken';
import { livePreviewKey } from './livePreviewAuth';

export type LivePreviewMint =
  | { ok: true; url: string; expiresAt: number }
  | { ok: false; status: number; error: string };

/**
 * The live-view URL of one HTML file (§14.110), for the login `sid` — the
 * pane's POST route and the `/view` page's redirect mint through here. A
 * capability for the sandboxed page, which never sees the cookie: read-only,
 * this VPS, this root, the preview's extension allow-list, and only while
 * that login lives. Nothing is read from the VPS — the preview route does
 * that, request by request.
 */
export function mintLivePreview(vpsId: string, root: string, path: string, sid: string): LivePreviewMint {
  const [v] = db.select({ id: vps.id }).from(vps).where(eq(vps.id, vpsId)).all();
  if (!v) return { ok: false, status: 404, error: 'vps not found' };
  if (!root.startsWith('/') || root.length > 4096 || !path || path.length > 4096) {
    return { ok: false, status: 400, error: 'root and path are required' };
  }
  if (!isLiveHtmlName(path)) return { ok: false, status: 400, error: 'only HTML files have a live view' };
  const scope = livePreviewScope(root, path);
  // The route will apply exactly this parse to the URL: refuse here what it
  // would refuse there, with a sentence instead of a blank frame.
  if (parseLivePreviewPath(scope.path.split('/').map(encodeURIComponent)) !== scope.path) {
    return { ok: false, status: 400, error: 'this file name cannot be served in a live view' };
  }
  const exp = Math.floor(Date.now() / 1000) + LIVE_PREVIEW_TTL_SECS;
  const token = signLivePreviewToken({ vpsId, root: scope.root, sid, exp }, livePreviewKey());
  return { ok: true, url: livePreviewUrl(token, scope.path), expiresAt: exp * 1000 };
}
