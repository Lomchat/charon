'use client';
/**
 * A glyph per language / file role — the `colored` and `mono` icon styles
 * (`app.file_icons`, app/fileIconStyle.ts).
 *
 * Two kinds of drawing, both readable at the tree's 13px:
 *  · a BADGE (rounded square + two or three letters) for languages, whose
 *    names are what people actually recognise — TS, PY, GO;
 *  · a SHAPE for roles that have one everybody reads — braces, a prompt, a
 *    padlock, a database.
 *
 * No colour lives here. Each glyph paints with `--fi-hue`, set per type in
 * app.css from the theme's semantic tokens (§14.99); `mono` sets it to
 * `currentColor`, so the icon then follows the row (git status included).
 * Letters are cut out of a badge with `--bg`, the surface behind the row.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

export const FILE_TYPES = [
  'ts', 'js', 'py', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'cpp', 'cs', 'lua', 'r',
  'shell', 'html', 'xml', 'css', 'scss', 'json', 'yaml', 'config', 'md', 'text', 'csv', 'db',
  'vue', 'svelte', 'image', 'audio', 'video', 'pdf', 'archive', 'font', 'docker', 'git', 'env',
  'lock', 'npm', 'build', 'license', 'readme', 'agent', 'test', 'code', 'file',
] as const;
export type FileType = (typeof FILE_TYPES)[number];

// Whole names first: `package.json` is a package before it is JSON, a
// lockfile is a lock whatever its extension says.
const BY_NAME: Record<string, FileType> = {
  'package.json': 'npm',
  'package-lock.json': 'lock', 'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock', 'bun.lockb': 'lock',
  'cargo.lock': 'lock', 'poetry.lock': 'lock', 'gemfile.lock': 'lock', 'composer.lock': 'lock',
  'uv.lock': 'lock', 'go.sum': 'lock', 'flake.lock': 'lock',
  dockerfile: 'docker', '.dockerignore': 'docker', 'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker', 'compose.yml': 'docker', 'compose.yaml': 'docker',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git', '.mailmap': 'git',
  makefile: 'build', gnumakefile: 'build', 'cmakelists.txt': 'build', justfile: 'build',
  'taskfile.yml': 'build', 'build.gradle': 'build', 'build.gradle.kts': 'build',
  license: 'license', licence: 'license', copying: 'license', 'license.md': 'license',
  'license.txt': 'license', 'licence.md': 'license', 'licence.txt': 'license',
  'claude.md': 'agent', 'agents.md': 'agent', 'gemini.md': 'agent', '.cursorrules': 'agent',
  'copilot-instructions.md': 'agent',
  '.editorconfig': 'config', '.npmrc': 'config', '.nvmrc': 'config', '.prettierrc': 'config',
  '.eslintrc': 'config', '.browserslistrc': 'config',
};

const BY_EXT: Record<string, FileType> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyi: 'py', pyw: 'py',
  go: 'go', rs: 'rs', rb: 'rb', php: 'php', java: 'java', kt: 'kt', kts: 'kt', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'cs', lua: 'lua', r: 'r',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell',
  html: 'html', htm: 'html', xml: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss', styl: 'scss',
  json: 'json', jsonc: 'json', json5: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'config', ini: 'config', cfg: 'config', conf: 'config', properties: 'config',
  md: 'md', markdown: 'md', mdx: 'md',
  txt: 'text', log: 'text', text: 'text', rst: 'text', adoc: 'text',
  csv: 'csv', tsv: 'csv', sql: 'db', sqlite: 'db', sqlite3: 'db', db: 'db',
  vue: 'vue', svelte: 'svelte', lock: 'lock', env: 'env', mk: 'build', dockerfile: 'docker',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  ico: 'image', avif: 'image', tiff: 'image', tif: 'image', heic: 'image', heif: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', ogv: 'video', m4v: 'video', wmv: 'video', flv: 'video',
  pdf: 'pdf',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  '7z': 'archive', rar: 'archive', jar: 'archive', whl: 'archive',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  // Code without a glyph of its own still reads as code.
  pl: 'code', scala: 'code', dart: 'code', ex: 'code', exs: 'code', hs: 'code', zig: 'code',
  sol: 'code', gradle: 'code', tf: 'code', nix: 'code', vim: 'code', el: 'code', clj: 'code',
};

/** What a file IS, for its glyph. A test is a test before it is its language. */
export function fileType(name: string): FileType {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  if (/\.(test|spec)\.[a-z0-9]+$/.test(lower) || /^test_.+\.py$/.test(lower) || /_test\.(go|py)$/.test(lower)) {
    return 'test';
  }
  if (lower === '.env' || lower.startsWith('.env.')) return 'env';
  if (lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) return 'docker';
  if (lower.startsWith('readme')) return 'readme';
  if (lower.startsWith('license') || lower.startsWith('licence')) return 'license';
  if (/^tsconfig.*\.json$/.test(lower) || /^\.(eslintrc|prettierrc|babelrc)/.test(lower)) return 'config';
  const dot = lower.lastIndexOf('.');
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || 'file';
}

const base = {
  xmlns: 'http://www.w3.org/2000/svg', width: 16, height: 16, viewBox: '0 0 16 16',
  fill: 'none', 'aria-hidden': true,
} as const;
const line = { className: 'fi-stroke', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Letters cut out of a filled rounded square. Three letters go a size down. */
function Badge({ text, ...p }: P & { text: string }) {
  const small = text.length > 2;
  return (
    <svg {...base} {...p}>
      <rect className="fi-fill" x="1.25" y="2.25" width="13.5" height="11.5" rx="2.4" />
      <text className={`fi-ink fi-text${small ? ' sm' : ''}`} x="8" y={small ? 10.1 : 10.9} textAnchor="middle">
        {text}
      </text>
    </svg>
  );
}

const Shape = ({ children, ...p }: P & { children: React.ReactNode }) => (
  <svg {...base} {...p}><g {...line}>{children}</g></svg>
);

const SHEET = 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5Z M9 1.5V5.5H13';

const BADGE_TEXT: Partial<Record<FileType, string>> = {
  ts: 'TS', js: 'JS', py: 'PY', go: 'GO', rs: 'RS', rb: 'RB', php: 'PHP', java: 'JV', kt: 'KT',
  swift: 'SW', c: 'C', cpp: 'C++', cs: 'C#', lua: 'LUA', r: 'R', yaml: 'YML', svelte: 'SV', pdf: 'PDF',
};

export function FileTypeIcon({ type, ...p }: P & { type: FileType }) {
  const badge = BADGE_TEXT[type];
  if (badge) return <Badge text={badge} {...p} />;
  switch (type) {
    case 'json':
      return <Shape {...p}><path d="M6 2.5c-1.6 0-2 .8-2 2v1.6c0 .9-.5 1.4-1.4 1.9.9.5 1.4 1 1.4 1.9v1.6c0 1.2.4 2 2 2M10 2.5c1.6 0 2 .8 2 2v1.6c0 .9.5 1.4 1.4 1.9-.9.5-1.4 1-1.4 1.9v1.6c0 1.2-.4 2-2 2" /></Shape>;
    case 'html':
      return <Shape {...p}><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" /></Shape>;
    case 'xml':
      return <Shape {...p}><path d="M5 4.5 1.5 8 5 11.5M11 4.5 14.5 8 11 11.5M9.2 3.5l-2.4 9" /></Shape>;
    case 'css':
    case 'scss':
      return <Shape {...p}><path d="M6.4 2.8 5.2 13.2M10.8 2.8 9.6 13.2M2.8 6h10.8M2.4 10h10.8" /></Shape>;
    case 'shell':
      return <Shape {...p}><path d="M2.5 4.5 6 8l-3.5 3.5M8 12h5.5" /></Shape>;
    case 'md':
      return (
        <Shape {...p}>
          <rect x="1.25" y="3.25" width="13.5" height="9.5" rx="1.6" strokeWidth={1.2} />
          <path d="M3.8 10.3V5.7l2 2.4 2-2.4v4.6M11.3 5.7v4.4M9.7 8.7l1.6 1.6 1.6-1.6" strokeWidth={1.3} />
        </Shape>
      );
    case 'config':
      return (
        <Shape {...p}>
          <circle cx="8" cy="8" r="3.3" />
          <circle cx="8" cy="8" r="1.1" />
          <path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" />
        </Shape>
      );
    case 'env':
      return <Shape {...p}><circle cx="5" cy="8" r="2.6" /><path d="M7.6 8H14M12.2 8v2.2M10.2 8v1.6" /></Shape>;
    case 'lock':
      return (
        <Shape {...p}>
          <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.4" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 9.6v1.6" />
        </Shape>
      );
    case 'db':
      return (
        <Shape {...p}>
          <ellipse cx="8" cy="4" rx="5" ry="1.9" />
          <path d="M3 4v8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V4M3 8c0 1 2.2 1.9 5 1.9S13 9 13 8" />
        </Shape>
      );
    case 'csv':
      return <Shape {...p}><rect x="2" y="3" width="12" height="10" rx="1.4" /><path d="M2 6.5h12M2 9.8h12M6.6 3v10" /></Shape>;
    case 'text':
      return <Shape {...p}><path d={SHEET} /><path d="M5.3 8.3h5.4M5.3 10.6h5.4M5.3 12.2h3.2" strokeWidth={1.2} /></Shape>;
    case 'code':
      return <Shape {...p}><path d={SHEET} /><path d="M6.6 8.2 5.2 9.8l1.4 1.6M9.4 8.2l1.4 1.6-1.4 1.6" strokeWidth={1.2} /></Shape>;
    case 'image':
      return (
        <Shape {...p}>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.6" />
          <circle cx="5.6" cy="6.3" r="1.1" />
          <path d="m2.5 12 3.4-3.4 2.2 2.2 2.4-2.4 3 3" />
        </Shape>
      );
    case 'audio':
      return (
        <svg {...base} {...p}>
          <path className="fi-stroke" d="M6.2 11.6V4.2l6-1.6v7.6" strokeWidth={1.5} strokeLinejoin="round" />
          <circle className="fi-fill" cx="4.6" cy="11.7" r="1.8" />
          <circle className="fi-fill" cx="10.6" cy="10.2" r="1.8" />
        </svg>
      );
    case 'video':
      return (
        <svg {...base} {...p}>
          <rect className="fi-stroke" x="1.5" y="3.5" width="13" height="9" rx="1.6" strokeWidth={1.4} />
          <path className="fi-fill" d="M6.5 5.8v4.4L10.3 8Z" />
        </svg>
      );
    case 'archive':
      return (
        <Shape {...p}>
          <rect x="2.75" y="2.25" width="10.5" height="11.5" rx="1.4" />
          <path d="M8 2.5v1.3M8 5v1.3M8 7.5v1.1M6.9 9.6h2.2v2.3H6.9z" strokeWidth={1.2} />
        </Shape>
      );
    case 'font':
      return (
        <svg {...base} {...p}>
          <text className="fi-hue-text" x="8" y="12" textAnchor="middle">Aa</text>
        </svg>
      );
    case 'docker':
      return (
        <svg {...base} {...p}>
          <path className="fi-fill" d="M1.5 9.4h12.8c-.5 2.5-2.7 4.1-6 4.1-3.6 0-5.9-1.5-6.8-4.1Z" />
          <rect className="fi-fill" x="3" y="6.4" width="2.4" height="2.3" rx=".4" />
          <rect className="fi-fill" x="5.9" y="6.4" width="2.4" height="2.3" rx=".4" />
          <rect className="fi-fill" x="8.8" y="6.4" width="2.4" height="2.3" rx=".4" />
          <rect className="fi-fill" x="5.9" y="3.6" width="2.4" height="2.3" rx=".4" />
        </svg>
      );
    case 'git':
      return (
        <svg {...base} {...p}>
          <path className="fi-fill" d="M8 1.3 14.7 8 8 14.7 1.3 8Z" />
          <path className="fi-ink-stroke" d="M6.4 5.3v5.4M6.4 7.4c2 0 3.2.6 3.2 2.3" strokeWidth={1.2} strokeLinecap="round" fill="none" />
        </svg>
      );
    case 'readme':
      return (
        <svg {...base} {...p}>
          <circle className="fi-stroke" cx="8" cy="8" r="6" strokeWidth={1.4} />
          <path className="fi-stroke" d="M8 7.3v4" strokeWidth={1.6} strokeLinecap="round" />
          <circle className="fi-fill" cx="8" cy="5" r=".95" />
        </svg>
      );
    case 'license':
      return <Shape {...p}><circle cx="8" cy="6.2" r="3.7" /><path d="M5.7 9.2 4.6 14l3.4-1.8 3.4 1.8-1.1-4.8" /></Shape>;
    case 'agent':
      return (
        <svg {...base} {...p}>
          <path className="fi-fill" d="M8 1.3C8.6 5.4 10.6 7.4 14.7 8 10.6 8.6 8.6 10.6 8 14.7 7.4 10.6 5.4 8.6 1.3 8 5.4 7.4 7.4 5.4 8 1.3Z" />
        </svg>
      );
    case 'test':
      return <Shape {...p}><path d="M5.8 2h4.4M6.6 2v4.2L3 12.5a1.2 1.2 0 0 0 1 1.8h8a1.2 1.2 0 0 0 1-1.8L9.4 6.2V2M4.7 10h6.6" /></Shape>;
    case 'npm':
      return <Shape {...p}><path d="M8 1.8 13.5 4.9v6.2L8 14.2l-5.5-3.1V4.9ZM2.5 4.9 8 8l5.5-3.1M8 8v6.2" /></Shape>;
    case 'build':
      return <Shape {...p}><path d="M10.6 2.2a3.3 3.3 0 0 0-3.9 4.4L2.5 10.8a1.3 1.3 0 0 0 1.8 1.8l4.2-4.2a3.3 3.3 0 0 0 4.4-3.9l-2 2-1.6-.4-.4-1.6Z" /></Shape>;
    case 'vue':
      return (
        <svg {...base} {...p}>
          <path className="fi-fill" d="M1 2.5h3.1L8 9.3l3.9-6.8H15L8 14.5Z" />
          <path className="fi-ink" d="M4.1 2.5h2.2L8 5.4l1.7-2.9h2.2L8 9.3Z" />
        </svg>
      );
    default:
      return <Shape {...p}><path d={SHEET} /></Shape>;
  }
}
