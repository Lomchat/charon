import '@/app/themes.css';
import '@/app/globals.css';
import '@/app/agent-ui.css';
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import AppError from '@/app/AppError';
import ChunkReloadGuard from '@/app/ChunkReloadGuard';
import NotificationClickHandler from '@/app/NotificationClickHandler';
import { TooltipLayer } from '@/app/HoverTip';
import { reloadOnceForChunkError } from '@/app/chunkReload';

// What every page shares (the old root layout): the theme sheets (themes.css
// FIRST: it owns every colour token), the error boundary, the stale-chunk
// net, the notification-click router and the themed tooltips. The server
// renders <html data-theme> and the page's first data (#charon-seed).

/** The page's first data, as the server computed it (server/http/pages.ts). */
export function readSeed<T>(): T {
  const el = document.getElementById('charon-seed');
  return JSON.parse(el?.textContent || 'null') as T;
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    return error
      ? <AppError error={error} reset={() => this.setState({ error: null })} />
      : this.props.children;
  }
}

export function mount(page: ReactNode): void {
  // A lazy chunk of a replaced build (Vite's preload failure).
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault();
    reloadOnceForChunkError('vite:preloadError');
  });
  createRoot(document.getElementById('root')!).render(
    <Boundary>
      {page}
      <ChunkReloadGuard />
      <NotificationClickHandler />
      {/* Every `title` on every page, as a themed tooltip (app/HoverTip.tsx). */}
      <TooltipLayer />
    </Boundary>,
  );
}
