import './globals.css';
import './agent-ui.css';
import type { Metadata } from 'next';
import MobileRedirectPrompt from './MobileRedirectPrompt';

export const metadata: Metadata = {
  title: 'Charon',
  description: 'sessions Claude — chalco'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
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
        <MobileRedirectPrompt />
      </body>
    </html>
  );
}
