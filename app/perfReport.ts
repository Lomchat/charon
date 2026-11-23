// What THIS browser lived through, written to the hub's journal (POST
// /api/perf), which no headless probe on the server reproduces:
//   · `[client-perf]` long frames: Chrome's long-animation-frame entries
//     ≥ REPORT_MS while the page is visible, with the scripts that ran and the
//     input just before (wheel over the sidebar…);
//   · `[client-inp]` interactions: every click/tap/key's input → next paint
//     (Event Timing), summed up per flush — count, median, p90, worst — with
//     the slowest ones named (where, which control, and how the time split:
//     waiting for the main thread, handlers, rendering the next frame).
// Batched, one POST per FLUSH_MS at most. Unsupported browser: nothing.

const REPORT_MS = 120;
const FLUSH_MS = 30_000;
const MAX_BATCH = 20;
/** An input this close before a frame is its context. */
const INPUT_WINDOW_MS = 1_000;
/** Interactions named in a flush (the slowest ones). */
const WORST_NAMED = 3;
/** Kept per flush; a typing burst beyond it only feeds the counts. */
const MAX_INTERACTIONS = 400;

type LoafScript = {
  invoker?: string; invokerType?: string; sourceURL?: string; sourceFunctionName?: string;
  sourceCharPosition?: number; duration: number; forcedStyleAndLayoutDuration?: number;
};
type Loaf = PerformanceEntry & {
  blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; scripts?: LoafScript[];
};
type EventEntry = PerformanceEntry & {
  interactionId?: number; processingStart: number; processingEnd: number; target?: Node | null;
};
type Interaction = { ms: number; wait: number; run: number; kind: string; where: string; what: string };

function area(target: EventTarget | null | undefined): string {
  const el = target instanceof Element ? target : null;
  if (!el) return '';
  if (el.closest('.cs-scroll, .app-sidebar')) return 'sidebar';
  if (el.closest('.app-chat')) return 'chat';
  if (el.closest('.app-input-bar')) return 'composer';
  if (el.closest('.app-head, .tab-row')) return 'header';
  if (el.closest('.app-modal, .app-modal-bg')) return 'modal';
  if (el.closest('.tools-panel, .tp-tabs, .app-tools')) return 'tools';
  return el.tagName.toLowerCase();
}

/** The control an interaction hit, in a few words (its label, else its tag). */
function control(target: Node | null | undefined): string {
  const el = target instanceof Element ? target : null;
  if (!el) return '';
  const named = el.closest('[aria-label], [data-label], [title]');
  const label = named?.getAttribute('aria-label') || named?.getAttribute('data-label') || named?.getAttribute('title');
  if (label) return label.slice(0, 40);
  const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '';
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`.slice(0, 40);
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

let started = false;

export function startPerfReport(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  const types = PerformanceObserver.supportedEntryTypes ?? [];
  const loafs = types.includes('long-animation-frame');
  const events = types.includes('event');
  if (!loafs && !events) return;
  started = true;
  const loadedAt = performance.now();
  let input = { kind: '', where: '', at: -Infinity };
  for (const kind of ['wheel', 'pointerdown', 'keydown'] as const) {
    addEventListener(kind, (e) => { input = { kind, where: area(e.target), at: performance.now() }; },
      { capture: true, passive: true });
  }
  let batch: unknown[] = [];
  // interactionId → the interaction's slowest entry (pointerdown/up/click
  // of one tap are one interaction).
  let interactions = new Map<number, Interaction>();
  let timer: number | null = null;
  const flush = () => {
    timer = null;
    const list = [...interactions.values()];
    interactions = new Map();
    let inp: unknown = undefined;
    if (list.length) {
      const sorted = list.map((i) => i.ms).sort((a, b) => a - b);
      const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      inp = {
        n: list.length, p50: pct(sorted, 0.5), p90: pct(sorted, 0.9), max: sorted[sorted.length - 1],
        slow: list.filter((i) => i.ms >= 200).length,
        worst: list.sort((a, b) => b.ms - a.ms).slice(0, WORST_NAMED),
        upMin: Math.round((performance.now() - loadedAt) / 60_000),
        heapMb: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1_048_576) : 0,
        nodes: document.getElementsByTagName('*').length,
      };
    }
    if (!batch.length && !inp) return;
    const body = JSON.stringify({ frames: batch, inp });
    batch = [];
    void fetch('/api/perf', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' }, body,
    }).catch(() => {});
  };
  const schedule = () => { if (timer == null) timer = window.setTimeout(flush, FLUSH_MS); };

  if (loafs) {
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
          // A copy: `scripts` is a FrozenArray in recent Chrome (sort() throws).
          scripts: [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => ({
            inv: s.invoker ?? s.invokerType ?? '',
            src: `${(s.sourceURL ?? '').split('/').pop()}:${s.sourceCharPosition ?? -1}`,
            fn: s.sourceFunctionName ?? '',
            ms: Math.round(s.duration),
            layout: Math.round(s.forcedStyleAndLayoutDuration ?? 0),
          })),
        });
        if (batch.length > MAX_BATCH) batch.shift();
      }
      if (batch.length) schedule();
    }).observe({ type: 'long-animation-frame' });
  }

  if (events) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as EventEntry[]) {
        const id = e.interactionId ?? 0;
        if (!id || document.visibilityState !== 'visible') continue;
        const prev = interactions.get(id);
        if (prev && prev.ms >= e.duration) continue;
        if (!prev && interactions.size >= MAX_INTERACTIONS) continue;
        interactions.set(id, {
          ms: Math.round(e.duration),
          wait: Math.round(e.processingStart - e.startTime),
          run: Math.round(e.processingEnd - e.processingStart),
          kind: e.name.startsWith('key') ? 'key' : e.name.startsWith('pointer') || e.name === 'click' ? 'click' : e.name,
          where: area(e.target),
          what: control(e.target),
        });
      }
      if (interactions.size) schedule();
    // 16 ms is the floor Chrome accepts: every interaction that missed a frame.
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  }
  addEventListener('pagehide', flush);
}
