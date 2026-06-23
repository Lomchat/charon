import './globals.css';
import './agent-ui.css';
import type { Metadata, Viewport } from 'next';
import NotificationClickHandler from './NotificationClickHandler';

export const metadata: Metadata = {
  title: 'Charon',
  description: 'Hub for Claude Code sessions over SSH'
};

// Viewport for the single responsive UI. Without this, phones render the page
// in a ~980px virtual viewport zoomed out → the whole UI is tiny and unusable
// (this was the #1 cause of "mobile works badly"). Must ship WITH the
// responsive CSS in claude.css — device-width alone would overflow the fixed
// 3-col grid. §11.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#181b24',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
        <NotificationClickHandler />
      </body>
    </html>
  );
}
