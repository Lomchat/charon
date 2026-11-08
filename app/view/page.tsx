import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { isLiveHtmlName } from '@/lib/livePreview';
import { mintLivePreview } from '@/lib/server/hub/livePreviewMint';
import { hasStandaloneView } from '../fileViews';
// Page sheets, like `/` and `/desk`: the viewers are styled there.
import '../app.css';
import '../density.css';
import StandaloneFileView from '../StandaloneFileView';

// `/view?vps=<id>&root=<abs>&path=<rel>` — one file, full window, in a browser
// tab of its own (the pane's "New tab", `fileViews.ts § standaloneViewUrl`).
// Cookie-authenticated like `/`; the file is read through the same fs routes
// as the pane, which check containment per request. An HTML file goes to its
// live page instead (§14.110), minted for THIS login: the sandboxed page is
// the full window, and a reload of this URL mints afresh.
export const dynamic = 'force-dynamic';

type Search = Promise<Record<string, string | string[] | undefined>>;

function target(sp: Record<string, string | string[] | undefined>) {
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
  const path = one(sp.path);
  return { vpsId: one(sp.vps), root: one(sp.root), path, name: path.split('/').pop() || path };
}

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const { name } = target(await searchParams);
  return { title: name ? `${name} — Charon` : 'Charon' };
}

function Refusal({ text }: { text: string }) {
  return (
    <div className="sfv file-editor">
      <div className="dvm-note err">{text}</div>
    </div>
  );
}

export default async function ViewPage({ searchParams }: { searchParams: Search }) {
  const s = await requireSession();
  const { vpsId, root, path, name } = target(await searchParams);
  if (!vpsId || !root.startsWith('/') || root.length > 4096 || !path || path.length > 4096) {
    return <Refusal text="this link does not name a file" />;
  }
  const [v] = db.select({ id: vps.id }).from(vps).where(eq(vps.id, vpsId)).all();
  if (!v) return <Refusal text="this VPS is no longer in Charon" />;
  if (isLiveHtmlName(path)) {
    const m = mintLivePreview(vpsId, root, path, s.sessionId);
    if (m.ok) redirect(m.url);
    return <Refusal text={m.error} />;
  }
  if (!hasStandaloneView(name)) return <Refusal text="this file has no rendered view — open it in Charon" />;
  return <StandaloneFileView vpsId={vpsId} root={root} path={path} />;
}
