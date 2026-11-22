// A provider's own non-blocking warning (Codex deprecation / config / warning
// notifications), shown as one line in the transcript. Browser-safe.

export type ProviderNotice = { provider?: string; kind?: string; summary: string; details?: string };

/** The row/frame payload ⇒ the Msg content (JSON). */
export function providerNoticeContent(ev: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const notice: ProviderNotice = {
    summary: str(ev.summary) ?? '',
    ...(str(ev.provider) ? { provider: str(ev.provider) } : {}),
    ...(str(ev.kind) ? { kind: str(ev.kind) } : {}),
    ...(str(ev.details) ? { details: str(ev.details) } : {}),
  };
  return JSON.stringify(notice);
}

export function parseProviderNotice(content: string): ProviderNotice | null {
  try {
    const v = JSON.parse(content) as ProviderNotice;
    return v && typeof v.summary === 'string' && v.summary ? v : null;
  } catch {
    return null;
  }
}
