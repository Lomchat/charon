// themes.css FIRST: it owns every colour token the two sheets below consume,
// and it must be in the layout (not page.tsx) so that /login and the modals
// portaled to <body> are themed too (§11).
import './themes.css';
import './globals.css';
import './agent-ui.css';
import type { Metadata, Viewport } from 'next';
import NotificationClickHandler from './NotificationClickHandler';
import ChunkReloadGuard from './ChunkReloadGuard';
import { getSetting } from '@/lib/server/claude/settings';
import { resolveTheme } from './themes';

// The active theme is read from the DB and rendered onto <html data-theme>.
// Server-side is what makes it flash-free — a localStorage read in an inline
// script would paint the default first. force-dynamic because that read must
// happen per request, not once at build (where the DB is :memory:, §14.69).
export const dynamic = 'force-dynamic';

function activeTheme() {
  // A settings read must never be what takes the hub down: an unreadable DB
  // still renders, in the default theme.
  try { return resolveTheme(getSetting('app.theme')); } catch { return resolveTheme(null); }
}

export const metadata: Metadata = {
  title: 'Charon',
  description: 'Hub for Claude Code sessions over SSH'
};

// Viewport for the single responsive UI. Without this, phones render the page
// in a ~980px virtual viewport zoomed out → the whole UI is tiny and unusable
// (this was the #1 cause of "mobile works badly"). Must ship WITH the
// responsive CSS in claude.css — device-width alone would overflow the fixed
// 3-col grid. §11.
export function generateViewport(): Viewport {
  return {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    themeColor: activeTheme().themeColor,
    viewportFit: 'cover',
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme={activeTheme().id}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <ChunkReloadGuard />
        <NotificationClickHandler />
      </body>
    </html>
  );
}
