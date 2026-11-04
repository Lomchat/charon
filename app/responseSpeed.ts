import type { WorkerEvent } from '@/lib/server/hub/types';

const WINDOW_MS = 3_000;
const BUCKET_MS = 100;
const encoder = new TextEncoder();

export type ResponseSpeedSnapshot = {
  bytesPerSecond: number;
  tokensPerSecond: number | null;
  sdkAgeSeconds: number | null;
};

/** Keep measured UTF-8 reception separate from native SDK token reports. */
export class ResponseSpeedTracker {
  private samples: Array<{ at: number; bytes: number }> = [];
  private startedAt: number | null = null;
  private sdkRate: number | null = null;
  private sdkMeasuredAt: number | null = null;
  private sdkElapsedMs = -1;

  reset(): void {
    this.samples = [];
    this.startedAt = null;
    this.sdkRate = this.sdkMeasuredAt = null;
    this.sdkElapsedMs = -1;
  }

  start(now: number): void {
    if (Number.isFinite(now) && this.startedAt == null) this.startedAt = now;
  }

  stopReception(): void {
    this.samples = [];
    this.startedAt = null;
  }

  /** `catchUp`: the frame came from the hub's ring on an SSE resume
   *  (EventReception.catchUp) — not live traffic, so it never feeds the kB/s
   *  gauge (§14.50); its turn-state effects still apply. */
  observe(event: WorkerEvent, now: number, receivedBytes?: number, catchUp = false): boolean {
    if (!Number.isFinite(now)) return false;
    let reset = false;
    if (!event.replay) {
      if (event.type === 'user_echo' || event.type === 'external_message') {
        this.reset();
        reset = true;
      } else if (event.type === 'reconnecting') {
        this.reset();
        return true;
      } else if (event.type === 'status' && event.status !== 'thinking'
        || ['stop', 'error', 'turn_error', 'blocking_error'].includes(event.type)) {
        this.stopReception();
        return false;
      } else if (event.type === 'status' && event.status === 'thinking' && this.startedAt == null) {
        this.reset();
      }
    }
    this.start(now);
    if (now < this.startedAt!) {
      this.reset();
      this.start(now);
      reset = true;
    }

    // e.data's UTF-8 size comes from the singleton EventSource before parsing.
    // Agent replays are traffic too; only their old SDK counters must be
    // ignored. A ring catch-up is not reception at all.
    const bytes = catchUp ? NaN : receivedBytes ?? encoder.encode(JSON.stringify(event)).byteLength;
    if (Number.isFinite(bytes) && bytes >= 0) {
      this.trim(now);
      const last = this.samples.at(-1);
      if (last && Math.floor(now / BUCKET_MS) === Math.floor(last.at / BUCKET_MS)) {
        last.at = now;
        last.bytes += bytes;
      } else {
        this.samples.push({ at: now, bytes });
      }
    }
    if (!event.replay && event.type === 'usage' && event.sdk_throughput) {
      const { output_tokens: tokens, elapsed_ms: elapsed } = event.sdk_throughput;
      if (Number.isSafeInteger(tokens) && tokens >= 0 && Number.isFinite(elapsed)
        && elapsed > 0 && elapsed > this.sdkElapsedMs) {
        this.sdkRate = tokens * 1_000 / elapsed;
        this.sdkMeasuredAt = now;
        this.sdkElapsedMs = elapsed;
      }
    }
    return reset;
  }

  private trim(now: number): void {
    while (this.samples.length && this.samples[0].at <= now - WINDOW_MS) this.samples.shift();
  }

  read(now: number): ResponseSpeedSnapshot | null {
    if (!Number.isFinite(now) || this.startedAt != null && now < this.startedAt) return null;
    if (this.startedAt == null && this.sdkRate == null) return null;
    this.trim(now);
    const elapsed = this.startedAt == null ? WINDOW_MS : Math.max(500, Math.min(WINDOW_MS, now - this.startedAt));
    return {
      bytesPerSecond: this.samples.reduce((total, sample) => total + sample.bytes, 0) * 1_000 / elapsed,
      tokensPerSecond: this.sdkRate,
      sdkAgeSeconds: this.sdkMeasuredAt == null ? null : Math.floor((now - this.sdkMeasuredAt) / 1_000),
    };
  }
}
