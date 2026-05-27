'use client';
import React from 'react';

// SessionErrorBoundary
// ─────────────────────────────────────────────────────────────────────────────
// React error boundary that AUTO-RECOVERS instead of leaving a dead tree.
//
// Why this exists (CLAUDE.md §14 gotcha 24):
//   The live-update pipeline (SSE subscription, 5s polling loop,
//   refetch-on-reconnect) all live inside `useClaudeSessionStream`, which
//   runs inside `<ClaudeSessionView>`. If ANY render in that subtree throws
//   — a hydration mismatch (React 19 error #418), a transient undefined
//   while data is mid-flight, a bad markdown parse — React unwinds and
//   UNMOUNTS the subtree. Unmount fires every useEffect cleanup, which
//   kills the polling interval, the SSE subscription, and the reconnect
//   listener. Result: the chat freezes forever and only F5 brings it back,
//   because nothing is left alive to re-fetch.
//
//   Without a boundary, a single render error anywhere in the chat is a
//   permanent freeze. With this boundary, the error is contained, we show
//   a tiny "reconnecting" placeholder, and we REMOUNT the subtree after a
//   short delay (bumping `recoveryKey`). Remount re-runs all the effects →
//   polling + SSE + refetch all restart → the chat self-heals within ~1.5s.
//
//   This is the universal safety net: it doesn't matter WHICH render bug
//   occurs, the boundary catches it and the system recovers. Combined with
//   the polling loop, the chat is guaranteed to come back without a manual
//   refresh.
//
// The boundary also resets when `resetKey` changes (e.g. the selected
// session id), so switching sessions never shows a stale error.

type Props = {
  children: React.ReactNode;
  // When this value changes, the boundary clears any error state (so a new
  // session doesn't inherit the previous one's error). Typically the
  // sessionId.
  resetKey?: string | number;
  // Auto-retry delay after catching an error (ms). Default 1500.
  retryAfterMs?: number;
  // Optional label shown in the placeholder.
  label?: string;
};

type State = {
  hasError: boolean;
  // Bumped on each recovery to force-remount the children subtree.
  recoveryKey: number;
  lastResetKey: string | number | undefined;
};

// If the boundary catches this many errors within this window, the error is
// clearly deterministic (the same render keeps throwing — remounting just
// re-throws). Remounting won't help; only a clean page load will. So we
// escalate to `window.location.reload()` — literally "simulate the refresh
// the user would do by hand", which is known to always recover.
const LOOP_THRESHOLD = 4;
const LOOP_WINDOW_MS = 8_000;

export class SessionErrorBoundary extends React.Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Timestamps of recent catches, for loop detection.
  private recentErrors: number[] = [];

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, recoveryKey: 0, lastResetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // If the caller changed resetKey (e.g. switched session), drop any
    // error immediately and remount fresh.
    if (props.resetKey !== state.lastResetKey) {
      return {
        hasError: false,
        recoveryKey: state.recoveryKey + 1,
        lastResetKey: props.resetKey,
      };
    }
    return null;
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Log so we can see WHICH render threw (the production build minifies
    // component names, but the message + stack still help).
    // eslint-disable-next-line no-console
    console.error('[charon] SessionErrorBoundary caught — auto-recovering:', error, info);

    // Loop detection: if we've caught several errors in a short window, a
    // plain remount is futile (the same data re-renders and re-throws). Do
    // a hard page reload — the nuclear "simulate the manual refresh" that
    // always works because it rebuilds the entire app + data from scratch.
    const now = Date.now();
    this.recentErrors = this.recentErrors.filter((t) => now - t < LOOP_WINDOW_MS);
    this.recentErrors.push(now);
    if (this.recentErrors.length >= LOOP_THRESHOLD && typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn(`[charon] SessionErrorBoundary: ${this.recentErrors.length} errors in ${LOOP_WINDOW_MS}ms — hard reload`);
      window.location.reload();
      return;
    }
    this.scheduleRecovery();
  }

  private scheduleRecovery() {
    if (this.retryTimer != null) return;
    const delay = this.props.retryAfterMs ?? 1500;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Bump recoveryKey → children remount → all effects re-run →
      // polling/SSE/refetch restart → chat self-heals.
      this.setState((s) => ({ hasError: false, recoveryKey: s.recoveryKey + 1 }));
    }, delay);
  }

  componentWillUnmount() {
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', minHeight: 120, gap: 10, color: 'var(--ink-soft, #888)',
            fontSize: 13, fontStyle: 'italic',
          }}
        >
          <span
            style={{
              width: 12, height: 12, borderRadius: '50%',
              border: '2px solid currentColor', borderTopColor: 'transparent',
              display: 'inline-block', animation: 'charon-spin 0.8s linear infinite',
            }}
          />
          {this.props.label ?? 'reconnecting…'}
          <style>{`@keyframes charon-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }
    // The key forces a full remount of the subtree on each recovery.
    return (
      <React.Fragment key={this.state.recoveryKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}

export default SessionErrorBoundary;
