// instrumentation.ts — Next.js startup hook. `register()` runs ONCE when the
// server process boots (during `app.prepare()` in server.js), BEFORE any
// request and independently of any SSR page render.
//
// Why this exists (CLAUDE.md §14.45 — "frozen until F5" root cause):
// `autoConnectAgentsIfNeeded()` — which opens the per-VPS SSH AgentClients and
// registers the `onStatus('connected') → reconcileVpsAgentState` self-healing
// hook that re-attaches the SessionStreams — is only reachable via
// `seedInitialData()`. Before this hook, seed was called ONLY from
// SSR/server-action surfaces (app/page.tsx, app/m/select/page.tsx,
// app/login/actions.ts). So after `systemctl restart charon`, a browser tab
// that survives the restart reconnects its singleton SSE + 5s poll WITHOUT
// ever triggering an SSR render → the AgentClientPool + SessionStream maps stay
// empty → no live agent event ever arrives ("frozen until F5"; F5 = full page
// load = SSR = seed). It also meant background Web Push / Telegram
// notifications didn't fire until a human opened a browser.
//
// Arming seed here makes the agents connect (and reconcile) at process boot.
// The GET /api/claude/events route ALSO calls seedInitialData() as a guaranteed
// fallback for any surviving tab (belt and suspenders).
//
// register() runs in BOTH the nodejs and edge runtimes; we only seed in nodejs
// (better-sqlite3 + ssh spawn are node-only). seedInitialData is idempotent
// (its `initialized` flag + autoConnect's `globalThis._agentBooted` guard), so
// a later SSR / route call is a no-op.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Never during `next build` collection (cf. CLAUDE.md §14.12).
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  try {
    const { seedInitialData } = await import('@/lib/server/seed');
    seedInitialData();
    // eslint-disable-next-line no-console
    console.log('[charon] instrumentation: agents armed at boot (seedInitialData)');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[charon] instrumentation: seed failed', e);
  }
}
