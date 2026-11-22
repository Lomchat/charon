// Long frames of THIS browser, written to the hub's journal (`[client-perf]`,
// POST /api/perf): what the user's own machine was doing when the UI stuttered,
// which no headless probe on the server reproduces. Chrome's
// long-animation-frame entries ≥ REPORT_MS while the page is visible, with the
// scripts that ran and the input just before (wheel over the sidebar…);
// batched, one POST per FLUSH_MS at most. Unsupported browser: nothing.

const REPORT_MS = 120;
const FLUSH_MS = 30_000;
const MAX_BATCH = 20;
/** An input this close before a frame is its context. */
const INPUT_WINDOW_MS = 1_000;

type LoafScript = {
  invoker?: string; invokerType?: string; sourceURL?: string; sourceFunctionName?: string;
  sourceCharPosition?: number; duration: number; forcedStyleAndLayoutDuration?: number;
};
type Loaf = PerformanceEntry & {
  blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; scripts?: LoafScript[];
};

function area(target: EventTarget | null): string {
  const el = target instanceof Element ? target : null;
  if (!el) return '';
  if (el.closest('.cs-scroll, .app-sidebar')) return 'sidebar';
  if (el.closest('.app-chat')) return 'chat';
  if (el.closest('.app-input-bar')) return 'composer';
  if (el.closest('.app-head, .tab-row')) return 'header';
  return el.tagName.toLowerCase();
}

let started = false;

export function startPerfReport(): void {
  if (started || typeof PerformanceObserver === 'undefined'
    || !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return;
  started = true;
  let input = { kind: '', where: '', at: -Infinity };
  for (const kind of ['wheel', 'pointerdown', 'keydown'] as const) {
    addEventListener(kind, (e) => { input = { kind, where: area(e.target), at: performance.now() }; },
      { capture: true, passive: true });
  }
  let batch: unknown[] = [];
  let timer: number | null = null;
  const flush = () => {
    timer = null;
    if (!batch.length) return;
    const body = JSON.stringify({ frames: batch });
    batch = [];
    void fetch('/api/perf', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' }, body,
    }).catch(() => {});
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Loaf[]) {
      if (e.duration < REPORT_MS || document.visibilityState !== 'visible') continue;
      const end = e.startTime + e.duration;
      batch.push({
        at: Math.round(performance.timeOrigin + e.startTime),
        ms: Math.round(e.duration),
        block: Math.round(e.blockingDuration ?? 0),
        style: Math.round(e.styleAndLayoutStart ? end - e.styleAndLayoutStart : 0),
        ctx: input.at > e.startTime - INPUT_WINDOW_MS && input.at < end ? `${input.kind}@${input.where}` : '',
        nodes: document.getElementsByTagName('*').length,
        scripts: (e.scripts ?? []).sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => ({
          inv: s.invoker ?? s.invokerType ?? '',
          src: `${(s.sourceURL ?? '').split('/').pop()}:${s.sourceCharPosition ?? -1}`,
          fn: s.sourceFunctionName ?? '',
          ms: Math.round(s.duration),
          layout: Math.round(s.forcedStyleAndLayoutDuration ?? 0),
        })),
      });
      if (batch.length > MAX_BATCH) batch.shift();
    }
    if (batch.length && timer == null) timer = window.setTimeout(flush, FLUSH_MS);
  }).observe({ type: 'long-animation-frame' });
  addEventListener('pagehide', flush);
}
