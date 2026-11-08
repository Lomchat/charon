'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { LIVE_PREVIEW_ESCAPE, LIVE_PREVIEW_SANDBOX, livePreviewWatches } from '@/lib/livePreview';
import { relayEscape } from './escapeRelay';
import { useFileActivity } from './fileActivityStore';
import { subscribeFsChanged } from './fsChangeBus';
import { IconArrowClockwise } from './icons';

type Props = {
  vpsId: string;
  root: string;
  /** Relative to `root`. */
  path: string;
  /** Bumped by the pane whenever IT (re)read or saved the file: reload. */
  rev: number;
  /** Unsaved edits in the Code view — the page shows the file on disk. */
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  /** The pane is on screen. A hidden page keeps its state; reloads wait. */
  active?: boolean;
};

/** Re-mint a link that would expire within the hour rather than reload a 403. */
const REMINT_MARGIN_MS = 60 * 60 * 1000;
// `file_activity` fires when the agent CALLS its write tool, before the bytes
// land: give the write a moment, and let a burst of edits settle into one.
const ACTIVITY_SETTLE_MS = 1500;
const WATCH_SETTLE_MS = 300;
const NOTE_MS = 4000;

function leaf(p: string): string {
  return p.split('/').pop() || p;
}

/**
 * The page as a browser renders it, beside nothing: an iframe on the
 * sandboxed preview route (§14.110). Its scripts run in an opaque origin, so
 * nothing here can reach the hub; the URL carries its own authorization.
 *
 * "Live": it reloads when the file is saved here, when the pane notices it
 * changed on the VPS, and when an agent writes one of the page's assets (its
 * folder's styles, scripts, images…).
 */
export default function HtmlLiveView({ vpsId, root, path, rev, dirty, saving, onSave, active = true }: Props) {
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const linkRef = useRef(link);
  linkRef.current = link;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mint = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.fsLivePreview(vpsId, root, path);
      if (!r.ok || !r.url) { setLink(null); setErr(r.error ?? 'could not open the live view'); return; }
      setLoading(true);
      setLink({ url: r.url, expiresAt: r.expiresAt ?? Date.now() + REMINT_MARGIN_MS });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [vpsId, root, path]);

  useEffect(() => { setLink(null); void mint(); }, [mint]);

  const reload = useCallback((why: string | null) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote(why);
    if (why) noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
    const cur = linkRef.current;
    if (!cur || cur.expiresAt - Date.now() < REMINT_MARGIN_MS) { void mint(); return; }
    setLoading(true);
    setNonce((n) => n + 1);
  }, [mint]);

  // A hidden page (another tab is in front, §14.111) keeps its scroll and
  // state: a change seen meanwhile is applied when it is shown again.
  const activeRef = useRef(active);
  activeRef.current = active;
  const pending = useRef<string | null>(null);
  const schedule = useCallback((delay: number, why: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (activeRef.current) reload(why); else pending.current = why;
    }, delay);
  }, [reload]);
  useEffect(() => {
    if (!active || pending.current == null) return;
    const why = pending.current;
    pending.current = null;
    reload(why);
  }, [active, reload]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);

  // The pane's own reads and saves.
  const seenRev = useRef(rev);
  useEffect(() => {
    if (rev === seenRev.current) return;
    seenRev.current = rev;
    reload(null);
  }, [rev, reload]);

  const absPath = `${root.replace(/\/+$/, '')}/${path}`;
  const dir = absPath.slice(0, absPath.lastIndexOf('/')) || '/';

  // An agent writing the page's assets (§14.88). Only writes newer than what
  // was already lit when the view opened: an old entry is not a change.
  const activity = useFileActivity(vpsId);
  const lastWrite = useMemo(() => {
    let at = 0;
    let which = '';
    for (const [p, a] of activity) {
      if (a.kind === 'write' && a.at > at && livePreviewWatches(dir, p)) { at = a.at; which = p; }
    }
    return { at, path: which };
  }, [activity, dir]);
  const seenWrite = useRef(lastWrite.at);
  useEffect(() => {
    if (lastWrite.at <= seenWrite.current) return;
    seenWrite.current = lastWrite.at;
    schedule(ACTIVITY_SETTLE_MS, `${leaf(lastWrite.path)} changed`);
  }, [lastWrite, schedule]);

  // An Esc pressed inside the page (its injected relay, lib/livePreview.ts):
  // only OUR frame's window is heard — the origin is opaque, the source is not.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (frame && e.source === frame.contentWindow && e.data === LIVE_PREVIEW_ESCAPE) relayEscape(frame);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Watch notifications report a write that already landed.
  useEffect(() => subscribeFsChanged((changedVpsId, paths) => {
    if (changedVpsId !== vpsId) return;
    const hit = paths.find((p) => livePreviewWatches(dir, p));
    if (hit) schedule(WATCH_SETTLE_MS, `${leaf(hit)} changed`);
  }), [vpsId, dir, schedule]);

  return (
    <div className="hlv">
      <div className="viewer-bar">
        <span className="hlv-badge" title="Scripts run in an isolated sandbox: the page cannot reach Charon">
          live
        </span>
        {dirty ? (
          <span className="viewer-bar-note warn">
            unsaved edits are not shown —{' '}
            <button type="button" className="hlv-inline" onClick={onSave} disabled={saving}>
              {saving ? 'saving…' : 'save'}
            </button>
          </span>
        ) : note ? (
          <span className="viewer-bar-note">reloaded · {note}</span>
        ) : loading && link ? (
          <span className="viewer-bar-note">loading…</span>
        ) : null}
        <span className="viewer-bar-spacer" />
        <button type="button" onClick={() => reload(null)} title="Reload the page">
          <IconArrowClockwise /> Reload
        </button>
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      {link && (
        <iframe
          key={`${link.url}#${nonce}`}
          ref={frameRef}
          className="hlv-frame"
          src={link.url}
          title={`Live view of ${leaf(path)}`}
          sandbox={LIVE_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          allowFullScreen
          onLoad={() => setLoading(false)}
        />
      )}
    </div>
  );
}
