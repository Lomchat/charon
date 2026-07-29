import { describe, it, expect } from 'vitest';
import { sanitizeAttachmentName, previewMimeFor } from '../lib/server/claude/attachmentNames';

// ── Session attachments ──────────────────────────────────────────────────────
// Two pure functions carry the load of the drag & drop feature, and both fail
// in ways that are invisible until a user hits them:
//
//  - sanitizeAttachmentName decides what a browser-supplied filename becomes on
//    a remote filesystem. It is a defence in depth (every interpolation is
//    already shQuote'd) but it is the layer that decides whether a path is
//    usable at all afterwards.
//  - previewMimeFor decides what may be rendered INLINE in a browser tab, and
//    is a SECURITY boundary: get it wrong and an upload becomes stored XSS on
//    Charon's own origin.

describe('sanitizeAttachmentName', () => {
  it('keeps an ordinary name untouched', () => {
    expect(sanitizeAttachmentName('screenshot.png')).toBe('screenshot.png');
    expect(sanitizeAttachmentName('Rapport Q3 final.pdf')).toBe('Rapport Q3 final.pdf');
  });

  it('keeps unicode — a French or Japanese name is not a threat', () => {
    expect(sanitizeAttachmentName('résumé-écran.png')).toBe('résumé-écran.png');
    expect(sanitizeAttachmentName('スクリーンショット.png')).toBe('スクリーンショット.png');
  });

  it('reduces any path to its last segment (no traversal survives)', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentName('/absolute/path/img.png')).toBe('img.png');
    expect(sanitizeAttachmentName('C:\\Users\\bob\\img.png')).toBe('img.png');
    expect(sanitizeAttachmentName('../../../..')).toBe('file');
  });

  it('never returns a name that starts with a dot or a dash', () => {
    // A leading dot would hide the file from the agent's own `ls`; a leading
    // dash makes it argv-ambiguous for anything the agent runs on it.
    expect(sanitizeAttachmentName('.hidden')).toBe('hidden');
    expect(sanitizeAttachmentName('..')).toBe('file');
    expect(sanitizeAttachmentName('-rf')).toBe('rf');
    expect(sanitizeAttachmentName('--flag.txt')).toBe('flag.txt');
  });

  it('neutralises control characters without merging words', () => {
    // Replaced by a space, not deleted: `a\nb.png` becoming `ab.png` would be
    // a name the user can no longer recognise in the Files tab.
    expect(sanitizeAttachmentName('a\nb\tc.png')).toBe('a b c.png');
    expect(sanitizeAttachmentName('nul\u0000byte.png')).toBe('nul byte.png');
  });

  it('neutralises shell metacharacters so the path stays copy-pasteable', () => {
    expect(sanitizeAttachmentName('$(whoami).png')).toBe('_whoami_.png');
    expect(sanitizeAttachmentName('a`b`c.png')).toBe('a_b_c.png');
    expect(sanitizeAttachmentName("it's;rm -rf.png")).toBe('it_s_rm -rf.png');
    expect(sanitizeAttachmentName('a|b&c>d.png')).toBe('a_b_c_d.png');
  });

  it('never returns an empty string', () => {
    expect(sanitizeAttachmentName('')).toBe('file');
    expect(sanitizeAttachmentName('   ')).toBe('file');
    expect(sanitizeAttachmentName('...')).toBe('file');
    // eslint-disable-next-line no-control-regex
    expect(sanitizeAttachmentName('\u0000\u0001')).toBe('file');
  });

  it('caps the length while preserving the extension', () => {
    const long = 'a'.repeat(400) + '.png';
    const out = sanitizeAttachmentName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.png')).toBe(true);
  });
});

describe('previewMimeFor', () => {
  it('resolves the common browser-renderable types', () => {
    expect(previewMimeFor('shot.png')).toBe('image/png');
    expect(previewMimeFor('scan.PDF')).toBe('application/pdf');   // case-insensitive
    expect(previewMimeFor('note.mp3')).toBe('audio/mpeg');
    expect(previewMimeFor('clip.mp4')).toBe('video/mp4');
  });

  it('serves every text-ish file as text/plain, never a renderable document', () => {
    // A .md or .json rendered as a document would be a scripting surface. The
    // preview is a preview; it is never "open this as a web page".
    for (const n of ['a.md', 'a.json', 'a.csv', 'a.xml', 'a.log', 'a.js', 'a.css']) {
      expect(previewMimeFor(n)).toBe('text/plain');
    }
  });

  it('refuses anything not on the allow-list', () => {
    // THE security test. `.html` / `.htm` / `.xhtml` must never be previewable:
    // served inline from our origin they would execute as Charon itself.
    for (const n of ['evil.html', 'evil.htm', 'evil.xhtml', 'evil.exe', 'a.zip', 'a.docx', 'noext']) {
      expect(previewMimeFor(n)).toBeNull();
    }
  });

  it('is driven by the extension, so a lying browser mime cannot widen it', () => {
    // The stored `mime` comes from the uploading browser and is attacker
    // controlled — it is deliberately not an input to this function at all.
    expect(previewMimeFor('payload.html.png')).toBe('image/png');
    expect(previewMimeFor('payload.png.html')).toBeNull();
  });

  it('allows svg (neutralised by the route CSP sandbox) but not by sniffing', () => {
    // SVG can carry <script>; it is previewable ONLY because the route sends
    // `Content-Security-Policy: sandbox`. If that header ever goes away, this
    // entry must go with it.
    expect(previewMimeFor('logo.svg')).toBe('image/svg+xml');
  });
});
