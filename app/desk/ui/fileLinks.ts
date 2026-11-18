'use client';
// File links on the desk (C4): no explorer here, so a file opens in its own
// browser tab (`/view`) when it has a page, else its path is copied.
import type { FileLinkHandler } from '@/app/Message';
import { hasStandaloneView, standaloneViewUrl } from '@/app/fileViews';
import type { MessageFileTarget } from '@/app/messageLinks';

function absPath(file: MessageFileTarget): string {
  return `${file.root.replace(/\/$/, '')}/${file.path}${file.line ? `:${file.line}` : ''}`;
}

export function makeDeskFileLinks(note: (text: string) => void): FileLinkHandler {
  return {
    hrefFor: (file) => {
      // `/view` reads under an absolute root only (a `~/…` root has no page).
      if (!file.root.startsWith('/')) return null;
      const name = file.path.split('/').pop() ?? file.path;
      // A cited line wants the code view; else a rendered page; else source as code.
      if (file.line) return standaloneViewUrl(file.vpsId, file.root, file.path, { code: true, line: file.line });
      return hasStandaloneView(name)
        ? standaloneViewUrl(file.vpsId, file.root, file.path)
        : standaloneViewUrl(file.vpsId, file.root, file.path, { code: true });
    },
    onUnavailable: (file) => {
      const abs = absPath(file);
      // No clipboard (a hub reached over plain HTTP): the path is at least shown.
      const clipboard = navigator.clipboard;
      if (!clipboard) { note(abs); return; }
      void clipboard.writeText(abs).then(() => note(`copied ${abs}`), () => note(abs));
    },
  };
}
