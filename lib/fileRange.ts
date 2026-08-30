export type ByteRange = { start: number; end: number; length: number };
export type ByteRangeResult =
  | { ok: true; range: ByteRange | null }
  | { ok: false };

/** Parse one RFC 7233 byte range. Multiple ranges are deliberately refused. */
export function parseByteRange(header: string | null, size: number): ByteRangeResult {
  if (!header) return { ok: true, range: null };
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return { ok: false };

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start >= size) return { ok: false };
    if (!match[2]) {
      end = size - 1;
    } else {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) return { ok: false };
      end = Math.min(end, size - 1);
    }
  }
  return { ok: true, range: { start, end, length: end - start + 1 } };
}
