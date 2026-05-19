import type { Viewport } from 'next';
import './mobile.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#181b24',
  viewportFit: 'cover',
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return <div className="m-root">{children}</div>;
}
