import { describe, expect, it } from 'vitest';
import { ResponseSpeedTracker } from '@/app/responseSpeed';
import type { WorkerEvent } from '@/lib/server/hub/types';

const text: WorkerEvent = { type: 'assistant_text', delta: '🧠 Bonjour' };
const usage = (tokens: number, elapsed: number): WorkerEvent => ({
  type: 'usage', output_tokens: tokens, sdk_throughput: { output_tokens: tokens, elapsed_ms: elapsed },
});

describe('measured reception and SDK throughput', () => {
  it('waits for a timed SDK report even while text/reasoning/tools arrive', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    const events: WorkerEvent[] = [text, { type: 'thinking', text: 'reasoning' },
      { type: 'tool_use', id: 't', name: 'Bash', input: {} },
      { type: 'tool_result', tool_use_id: 't', content: 'stdout', is_error: false },
      { type: 'generation_progress', characters: 100_000 },
      { type: 'usage', output_tokens: 100_000 }];
    for (const event of events) tracker.observe(event, 1_000, 100);
    expect(tracker.read(1_000)).toEqual({ bytesPerSecond: 600, tokensPerSecond: null, sdkAgeSeconds: null });
  });

  it('counts actual UTF-8 payload bytes, including JSON whitespace from the transport', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    const raw = JSON.stringify(text) + ' '.repeat(1000);
    const bytes = new TextEncoder().encode(raw).byteLength;
    tracker.observe(text, 1_000, bytes);
    expect(tracker.read(1_000)?.bytesPerSecond).toBe(bytes);
    tracker.observe(text, 2_000);
    expect(tracker.read(2_000)?.bytesPerSecond).toBe((bytes + new TextEncoder().encode(JSON.stringify(text)).byteLength) / 2);
  });

  it('expires reception after three seconds but freezes the last SDK rate and increases its age', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    tracker.observe(usage(120, 3_000), 3_000, 300);
    expect(tracker.read(3_000)).toEqual({ bytesPerSecond: 100, tokensPerSecond: 40, sdkAgeSeconds: 0 });
    expect(tracker.read(6_000)).toEqual({ bytesPerSecond: 0, tokensPerSecond: 40, sdkAgeSeconds: 3 });
    expect(tracker.read(60_000)).toEqual({ bytesPerSecond: 0, tokensPerSecond: 40, sdkAgeSeconds: 57 });
    tracker.observe(usage(300, 10_000), 10_000, 100);
    expect(tracker.read(10_000)).toEqual({ bytesPerSecond: 100 / 3, tokensPerSecond: 30, sdkAgeSeconds: 0 });
  });

  it('does not add reasoning twice, or use input tokens, usage trees or received data as output tokens', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    tracker.observe({ ...usage(120, 3_000), input_tokens: 1_000_000,
      tree: { output_tokens: 9_999, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, models: [] } } as WorkerEvent, 3_000);
    tracker.observe({ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(40_000), is_error: false }, 4_000);
    expect(tracker.read(4_000)?.tokensPerSecond).toBe(40);
  });

  it('counts replay traffic but ignores replayed SDK counters and lifecycle boundaries', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    tracker.observe(usage(120, 3_000), 3_000, 100);
    for (const event of [usage(50_000, 20_000), { type: 'stop' } as WorkerEvent]) {
      tracker.observe({ ...event, replay: true }, 4_000, 100);
    }
    expect(tracker.read(4_000)).toEqual({ bytesPerSecond: 100, tokensPerSecond: 40, sdkAgeSeconds: 1 });
  });

  it.each([[NaN, 1000], [Infinity, 1000], [-1, 1000], [1.5, 1000], [10, 0], [10, -1], [10, NaN], [10, Infinity]])(
    'ignores invalid native counters %s/%s', (tokens, elapsed) => {
      const tracker = new ResponseSpeedTracker();
      tracker.observe(usage(tokens, elapsed), 0);
      expect(tracker.read(1000)?.tokensPerSecond).toBeNull();
    });

  it('ignores duplicate and older samples without making their timestamps look fresh', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.observe(usage(120, 3_000), 3_000);
    tracker.observe(usage(120, 3_000), 5_000);
    tracker.observe(usage(40_000, 2_000), 6_000);
    expect(tracker.read(6_000)?.tokensPerSecond).toBe(40);
    expect(tracker.read(6_000)?.sdkAgeSeconds).toBe(3);
  });

  it('keeps the last SDK report on stop, including a report delivered after stop', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.observe(usage(120, 3_000), 3_000);
    tracker.observe({ type: 'stop' }, 4_000);
    tracker.stopReception();
    expect(tracker.read(4_000)?.tokensPerSecond).toBe(40);
    tracker.observe(usage(200, 5_000), 8_000);
    tracker.stopReception();
    expect(tracker.read(8_000)).toEqual({ bytesPerSecond: 0, tokensPerSecond: 40, sdkAgeSeconds: 0 });
  });

  it('clears both meters for a new turn or reconnect, including spontaneous turns', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.observe(usage(120, 3_000), 3_000);
    tracker.observe({ type: 'user_echo', content: 'next input', createdAt: 1 }, 4_000, 100);
    expect(tracker.read(4_000)?.tokensPerSecond).toBeNull();
    tracker.observe(usage(120, 3_000), 5_000);
    tracker.observe({ type: 'stop' }, 6_000);
    tracker.observe({ type: 'status', status: 'thinking' }, 7_000);
    expect(tracker.read(7_000)?.tokensPerSecond).toBeNull();
    tracker.observe({ type: 'reconnecting', attempt: 1, nextRetryIn: 1, reason: 'offline' }, 8_000);
    expect(tracker.read(8_000)).toBeNull();
  });

  it('bounds reception samples during sustained streaming', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    for (let at = 0; at <= 60_000; at++) tracker.observe(text, at, 100);
    expect(tracker.read(60_000)?.bytesPerSecond).toBeCloseTo(100_000, -2);
    expect((tracker as unknown as { samples: unknown[] }).samples.length).toBeLessThan(32);
  });
  it('skips ring catch-up frames (an SSE resume) in the kB/s gauge, still counts live ones', () => {
    const tracker = new ResponseSpeedTracker();
    tracker.start(0);
    tracker.observe(text, 1_000, 50_000, true);       // replayed from the hub's ring
    expect(tracker.read(1_000)?.bytesPerSecond).toBe(0);
    tracker.observe(text, 1_000, 300);                 // live
    expect(tracker.read(1_000)?.bytesPerSecond).toBe(300);
    // A catch-up SDK report still counts (it is not reception).
    tracker.observe(usage(120, 3_000), 2_000, 10_000, true);
    expect(tracker.read(2_000)?.tokensPerSecond).toBe(40);
    expect(tracker.read(2_000)?.bytesPerSecond).toBe(150);
  });
});
