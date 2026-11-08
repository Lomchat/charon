'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import ImageViewer from './ImageViewer';
import MarkdownFileView from './MarkdownFileView';
import type { ByteViewerProps, TextViewerProps, ViewerKind } from './fileViews';

// The rendered views (§14.112), shared by the file pane and the full-window
// `/view` page: each its own chunk, most with a library behind it (pdf.js,
// three.js, Leaflet, SheetJS, mammoth, viz.js) loaded only when such a file
// is actually opened. A failed lazy import after a deploy is caught by
// ChunkReloadGuard (§14.57).
const viewerLoading = () => <div className="dvm-note">loading viewer…</div>;
const PdfViewer = dynamic(() => import('./PdfViewer'), { ssr: false, loading: viewerLoading });
export const LogViewer = dynamic(() => import('./LogViewer'), { ssr: false, loading: viewerLoading });
export const HexViewer = dynamic(() => import('./HexViewer'), { ssr: false, loading: viewerLoading });
const JsonViewer = dynamic(() => import('./JsonViewer'), { ssr: false, loading: viewerLoading });
const DiagramViewer = dynamic(() => import('./DiagramViewer'), { ssr: false, loading: viewerLoading });
const SqliteViewer = dynamic(() => import('./SqliteViewer'), { ssr: false, loading: viewerLoading });
const ArchiveViewer = dynamic(() => import('./ArchiveViewer'), { ssr: false, loading: viewerLoading });
const ConvertedImageViewer = dynamic(() => import('./ConvertedImageViewer'), { ssr: false, loading: viewerLoading });
const OfficeViewer = dynamic(() => import('./OfficeViewer'), { ssr: false, loading: viewerLoading });
const DocxViewer = dynamic(() => import('./DocxViewer'), { ssr: false, loading: viewerLoading });
const SpreadsheetViewer = dynamic(() => import('./SpreadsheetViewer'), { ssr: false, loading: viewerLoading });
const NotebookViewer = dynamic(() => import('./NotebookViewer'), { ssr: false, loading: viewerLoading });
const GeoViewer = dynamic(() => import('./GeoViewer'), { ssr: false, loading: viewerLoading });
const FontViewer = dynamic(() => import('./FontViewer'), { ssr: false, loading: viewerLoading });
const ModelViewer = dynamic(() => import('./ModelViewer'), { ssr: false, loading: viewerLoading });

/** The binary formats: each viewer reads the bytes itself (§14.112). */
export function BytesView({ kind, props, mediaSrc }: { kind: ViewerKind; props: ByteViewerProps; mediaSrc: string }) {
  switch (kind) {
    case 'pdf': return <PdfViewer url={props.url} name={props.name} rev={props.rev} />;
    case 'image': return <ImageViewer src={mediaSrc} name={props.name} />;
    case 'audio':
    case 'video':
      return <div className="fvm-media"><PlayableMedia kind={kind} src={mediaSrc} active={props.active} /></div>;
    case 'convert-image': return <ConvertedImageViewer {...props} />;
    case 'office': return <OfficeViewer {...props} />;
    case 'docx': return <DocxViewer {...props} />;
    case 'spreadsheet': return <SpreadsheetViewer {...props} />;
    case 'sqlite': return <SqliteViewer {...props} />;
    case 'archive': return <ArchiveViewer {...props} />;
    case 'font': return <FontViewer {...props} />;
    case 'model3d': return <ModelViewer {...props} />;
    default: return <HexViewer vpsId={props.vpsId} root={props.root} path={props.path} rev={props.rev} />;
  }
}

/** The rendered side of a text format (the buffer, unsaved edits included). */
export function TextView({ kind, props }: { kind: ViewerKind; props: TextViewerProps }) {
  switch (kind) {
    case 'markdown': return <MarkdownFileView vpsId={props.vpsId} root={props.root} path={props.path} text={props.text} />;
    case 'svg':
    case 'mermaid':
    case 'graphviz':
      return <DiagramViewer {...props} kind={kind} />;
    case 'json': return <JsonViewer {...props} />;
    case 'notebook': return <NotebookViewer {...props} />;
    case 'geo': return <GeoViewer {...props} />;
    default: return null;
  }
}

/**
 * Audio/video that keeps its place: the element survives a tab switch with
 * the pane (§14.111) and pauses when the pane leaves the screen — coming back
 * finds it where it stopped, not playing on behind another tab. A container
 * or codec the browser cannot decode (AVI, WMV, FLV, some MKV) says so
 * instead of showing a dead player.
 */
function PlayableMedia({ kind, src, active }: { kind: 'audio' | 'video'; src: string; active: boolean }) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!active) ref.current?.pause(); }, [active]);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) {
    return (
      <div className="dvm-note warn">
        this browser cannot play this {kind === 'video' ? 'video' : 'audio'} format — use Download to play it locally
      </div>
    );
  }
  return kind === 'audio'
    ? <audio ref={(el) => { ref.current = el; }} src={src} controls onError={() => setFailed(true)} />
    : <video ref={(el) => { ref.current = el; }} src={src} controls onError={() => setFailed(true)} />;
}
