// terminalUrlDetect
// ─────────────────────────────────────────────────────────────────────────────
// Extracts "long" URLs from a terminal text buffer (typically from
// xterm.js), joining pieces separated by newlines/CR.
//
// Why: `claude login` displays an OAuth URL of ~250 chars which in an
// 80-col terminal is hard-wrapped by the remote program or soft-wrapped by
// xterm. In either case, the user cannot double-click / select cleanly to
// copy — hence an overlay that reconstructs the full URL.
//
// The algorithm handles both cases:
//   - HARD wrap: the program inserted `\n` in the middle of the URL. We
//     join by skipping `\r\n` when the next line starts with a URL-safe
//     character.
//   - SOFT wrap: no `\n` in the stream, just an xterm visual wrap. The
//     natural regex works, we extract the URL in one go.

// CSI (ESC [ ...), OSC (ESC ] ... BEL), and other common ANSI sequences.
// Sufficient for `claude login` which only uses standard CSI/OSC/SGR.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PXY^_].*?\x1b\\/g;

// Characters accepted in a URL: unreserved + reserved + % (percent-encoded).
// We deliberately exclude space, " and < to stop at the end of the token,
// even though technically some chars (space) could appear percent-encoded —
// but in practice, in an OAuth URL, we never encounter them decoded.
const URL_CHAR = /[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;

/**
 * Extracts "interesting" URLs (length >= minLen) from a text buffer.
 *
 * @param raw    Raw text as received from the SSE stream (may contain ANSI codes)
 * @param minLen Length threshold — below this, the user can copy by hand
 * @param maxLen Safety cap — beyond this, we stop to avoid pasting a URL
 *               together with a word that would follow at the newline (rare
 *               false positive but possible). 2000 amply covers real OAuth
 *               URLs (~300-800 chars typically).
 * @returns      Unique URLs in order of appearance (most recent at the tail)
 */
export function extractWrappedUrls(raw: string, minLen = 60, maxLen = 2000): string[] {
  // Strip ANSI first to avoid codes confusing the URL regex.
  const clean = raw.replace(ANSI_RE, '');
  const out: string[] = [];
  const seen = new Set<string>();
  const startRe = /https?:\/\//gi;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(clean)) !== null) {
    let pos = m.index + m[0].length;
    let url = m[0];
    while (pos < clean.length && url.length < maxLen) {
      const c = clean[pos];
      if (URL_CHAR.test(c)) {
        url += c;
        pos++;
        continue;
      }
      if (c === '\n' || c === '\r') {
        // Count consecutive newlines. More than 1 = paragraph break, stop
        // (don't swallow the text after the paragraph).
        // ZERO spaces tolerated between lines: a real OAuth URL has no
        // indentation on resume.
        let next = pos;
        let nlCount = 0;
        while (next < clean.length && (clean[next] === '\n' || clean[next] === '\r')) {
          if (clean[next] === '\n') nlCount++;
          next++;
        }
        if (nlCount > 1) break;       // paragraph break: stop
        if (next >= clean.length) break;
        if (URL_CHAR.test(clean[next])) {
          pos = next;
          continue;
        }
        break;
      }
      break;
    }
    if (url.length >= minLen && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
