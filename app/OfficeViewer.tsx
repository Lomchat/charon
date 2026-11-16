'use client';
import { useEffect, useState } from 'react';
import dynamic from '@/app/dynamic';
import { api } from '@/lib/api';
import type { ByteViewerProps } from './fileViews';

const PdfViewer = dynamic(() => import('./PdfViewer'), {
  ssr: false,
  loading: () => <div className="dvm-note">loading viewer…</div>,
});

/**
 * Presentations and other Office formats (pptx, odp, odt, doc, rtf…) through
 * LibreOffice on the VPS (§14.112): converted to PDF once per file version
 * (the agent caches it), then read in the PDF viewer. A VPS without
 * LibreOffice says so, with the package to install.
 */
export default function OfficeViewer({ vpsId, root, path, name, rev }: ByteViewerProps) {
  const [pdf, setPdf] = useState<{ root: string; path: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    void api.fsConvert(vpsId, { root, path, to: 'pdf' }).then((r) => {
      if (!alive) return;
      if (!r.ok || !r.root || !r.path) { setErr(r.error ?? 'could not convert this document'); return; }
      setPdf({ root: r.root, path: r.path });
    }, (e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [vpsId, root, path, rev]);

  if (err) return <div className="pdfv"><div className="dvm-note err">{err}</div></div>;
  if (!pdf) return <div className="pdfv"><div className="dvm-note">converting with LibreOffice on the VPS…</div></div>;
  return <PdfViewer url={api.fsFileUrl(vpsId, pdf.root, pdf.path)} name={name} rev={rev} />;
}
