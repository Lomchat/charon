'use client';
/**
 * File-type glyphs and git decoration for the explorer tree.
 *
 * Stroke-based at a single weight so the tree reads as one set at 13px, and
 * hand-drawn rather than pulled from a pack: the whole point is that a glance
 * down the gutter separates code from assets from documents, which needs the
 * shapes to differ at a glance, not to be individually pretty.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const stroke = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

// The dog-eared sheet every file glyph is built on.
const SHEET = 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10A1.5 1.5 0 0 0 4.5 14.5h7A1.5 1.5 0 0 0 13 13V5.5Z';
const FOLD = 'M9 1.5V5.5H13';

const Sheet = ({ children, ...p }: P & { children?: React.ReactNode }) => (
  <svg {...stroke} {...p}>
    <path d={SHEET} />
    <path d={FOLD} />
    {children}
  </svg>
);

export const IconFolder = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M1.5 12.5V3.5A1 1 0 0 1 2.5 2.5h3.2l1.4 1.8h5.4a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
  </svg>
);
export const IconFolderOpen = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M1.5 12.5V3.5A1 1 0 0 1 2.5 2.5h3.2l1.4 1.8h5.4a1 1 0 0 1 1 1v1.2" />
    <path d="M1.5 12.5 3.3 7.2a1 1 0 0 1 .95-.7h10.1a.6.6 0 0 1 .57.8l-1.6 4.7a1 1 0 0 1-.95.7Z" />
  </svg>
);
// Code: the angle brackets, the only universally-read "this is source" mark.
export const IconFileCode = (p: P) => (
  <Sheet {...p}>
    <path d="M6.6 8.2 5.2 9.8l1.4 1.6M9.4 8.2l1.4 1.6-1.4 1.6" />
  </Sheet>
);
export const IconFileText = (p: P) => (
  <Sheet {...p}><path d="M5.3 8.3h5.4M5.3 10.6h5.4M5.3 12.2h3.2" /></Sheet>
);
export const IconFileImage = (p: P) => (
  <Sheet {...p}>
    <circle cx="6.4" cy="8.7" r="0.85" />
    <path d="M4 12.6 6.7 10l1.6 1.6 1.5-1.4 2.1 2" />
  </Sheet>
);
export const IconFileAudio = (p: P) => (
  <Sheet {...p}>
    <path d="M6 12V8.6l3.6-.8V11" />
    <circle cx="5.1" cy="12.1" r="0.95" />
    <circle cx="8.7" cy="11.1" r="0.95" />
  </Sheet>
);
export const IconFileVideo = (p: P) => (
  <Sheet {...p}><path d="M6.2 8.4v4.2l3.6-2.1Z" /></Sheet>
);
export const IconFilePdf = (p: P) => (
  <Sheet {...p}><path d="M5 12.6c2.2-.6 3.4-2.6 3.2-4-.15-1-1.1-.9-1.05.25.1 2 3 4.1 4.6 3.6" /></Sheet>
);
export const IconFileArchive = (p: P) => (
  <Sheet {...p}><path d="M7.2 2v1.4M8.8 3.4v1.4M7.2 4.8v1.4M8.8 6.2v1.4M7.2 7.6v1.4" /><circle cx="8" cy="11.4" r="1.5" /></Sheet>
);
export const IconFileGeneric = (p: P) => <Sheet {...p} />;
// External link — "open this repo on its forge".
export const IconExternal = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M9.5 2.5H13.5V6.5" />
    <path d="M13.5 2.5 7.8 8.2" />
    <path d="M12 9.6v3.1a1 1 0 0 1-1 1H3.3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.1" />
  </svg>
);
// Folder-tree — the explorer tab's own glyph.
export const IconTree = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M1.8 2.2h4l1 1.3h2.4v2.6H1.8Z" />
    <path d="M4 6.1v6.3a1 1 0 0 0 1 1h1.6M4 9.4h2.6" />
    <path d="M8.2 11.4h6M8.2 8.1h6" />
  </svg>
);

// ── Context-menu actions ────────────────────────────────────────────────────
// Same stroke weight as the glyphs above, because the menu opens ON the tree:
// the app-wide fill set (`icons.tsx`) sitting a few pixels from a stroke row
// reads as two icon packs at once. Named for the ACTION, not the shape, both
// because that is how the call site reads and because `IconPencil`/`IconTrash`
// already mean the filled ones in `icons.tsx`.
export const IconFilePlus = (p: P) => (
  <Sheet {...p}><path d="M8 8v4.4M5.8 10.2h4.4" /></Sheet>
);
export const IconFolderPlus = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M1.5 12.5V3.5A1 1 0 0 1 2.5 2.5h3.2l1.4 1.8h5.4a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
    <path d="M7.5 7.3v4M5.5 9.3h4" />
  </svg>
);
// Two stacked sheets — "copy", the one glyph everyone reads without a label.
export const IconCopy = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M5.5 10.5h-2a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M6.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
  </svg>
);
// Arrow dropping onto a line — "insert this into the message below". Reads as
// a destination rather than a creation, which is what separates it from the
// two plus-badged glyphs above.
export const IconInsert = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M8 2.5v7.4M5.1 7l2.9 2.9L10.9 7" />
    <path d="M3 13.3h10" />
  </svg>
);
export const IconRename = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M11.2 2.8a1.4 1.4 0 0 1 2 2L6.4 11.6l-2.6.6.6-2.6z" />
  </svg>
);
export const IconDelete = (p: P) => (
  <svg {...stroke} {...p}>
    <path d="M2.5 4.5h11" />
    <path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5" />
    <path d="M3.8 4.5l.75 8.7a1 1 0 0 0 1 .9h4.9a1 1 0 0 0 1-.9l.75-8.7" />
    <path d="M6.6 7v4.2M9.4 7v4.2" />
  </svg>
);

// ── Extension → glyph ───────────────────────────────────────────────────────
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'lua', 'pl', 'r',
  'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'gradle', 'dockerfile']);
const TEXT = new Set(['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'rst', 'adoc', 'text']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'ogv', 'm4v']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'whl']);

export type FileKind = 'dir' | 'code' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'archive' | 'file';

export function fileKind(name: string, isDir: boolean): FileKind {
  if (isDir) return 'dir';
  const lower = name.toLowerCase();
  // Extension-less names that are unmistakably config/code in practice.
  if (lower === 'dockerfile' || lower === 'makefile' || lower.startsWith('.env')
    || lower === '.gitignore' || lower === '.dockerignore') return 'code';
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (CODE.has(ext)) return 'code';
  if (TEXT.has(ext)) return 'text';
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (ARCHIVE.has(ext)) return 'archive';
  return 'file';
}

export function IconForKind({ kind, open, className }: { kind: FileKind; open?: boolean; className?: string }) {
  switch (kind) {
    case 'dir': return open ? <IconFolderOpen className={className} /> : <IconFolder className={className} />;
    case 'code': return <IconFileCode className={className} />;
    case 'text': return <IconFileText className={className} />;
    case 'image': return <IconFileImage className={className} />;
    case 'audio': return <IconFileAudio className={className} />;
    case 'video': return <IconFileVideo className={className} />;
    case 'pdf': return <IconFilePdf className={className} />;
    case 'archive': return <IconFileArchive className={className} />;
    default: return <IconFileGeneric className={className} />;
  }
}

/** Extensions the browser can render inline — mirrors the server allow-list. */
const VIEWABLE_MEDIA = new Set([...IMAGE, ...AUDIO, ...VIDEO, 'pdf']);
export function isMediaName(name: string): boolean {
  const dot = name.toLowerCase().lastIndexOf('.');
  return dot > 0 && VIEWABLE_MEDIA.has(name.toLowerCase().slice(dot + 1));
}
