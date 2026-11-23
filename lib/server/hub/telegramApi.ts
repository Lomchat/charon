import 'server-only';

// undici's `fetch` throws a terse TypeError('fetch failed') on ANY network-
// level failure; the ACTIONABLE reason (DNS, timeout, ECONNRESET / stale
// keep-alive socket "other side closed", IPv6 unreachable…) lives in `.cause`
// (and `.cause.errors` for Happy-Eyeballs aggregates). Flatten it so the
// Settings "test" surfaces something better than a bare "fetch failed".
function describeFetchError(e: any): string {
  const parts: string[] = [];
  const top = e?.message ? String(e.message) : String(e);
  if (top) parts.push(top);
  const c = e?.cause;
  if (c) {
    if (c.code) parts.push(String(c.code));
    if (c.message && c.message !== top) parts.push(String(c.message));
    if (Array.isArray(c.errors)) {
      for (const sub of c.errors) {
        const m = `${sub?.code ?? ''} ${sub?.message ?? ''}`.trim();
        if (m) parts.push(m);
      }
    }
  }
  return Array.from(new Set(parts.filter(Boolean))).join(' — ');
}

// Default per-call timeout so a hung connection can't freeze the request.
// getUpdates long-polls (timeout:20) and passes a LARGER budget explicitly —
// keep this above any long-poll value used by callers.
export const TG_CALL_TIMEOUT_MS = 15_000;

/** One Bot API call; throws on a network failure or `ok:false`. */
export async function tgPost<T = any>(
  token: string, method: string, body: any, timeoutMs: number = TG_CALL_TIMEOUT_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError') {
      throw new Error(`tg ${method}: timed out after ${timeoutMs}ms reaching api.telegram.org`);
    }
    throw new Error(`tg ${method}: ${describeFetchError(e)}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`tg ${method}: ${data.description ?? 'unknown'}`);
  return data.result as T;
}
