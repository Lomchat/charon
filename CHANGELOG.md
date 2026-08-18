# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been tagged yet, so everything below is unreleased. Entries
predating the open-source release are grouped thematically rather than
commit-by-commit — `git log` has the detail.

## [Unreleased]

### Added

- **Codex as a second backend.** Every session carries a `kind`
  (`claude` | `codex`); Codex sessions are driven by the `openai-codex` Python
  SDK and translated into the same event vocabulary, so the whole chat UI is
  shared. A VPS can offer either backend, both, or neither.
- **Provider-parity session lifecycle:** exact-turn native forks, transcript
  transfer for Claude ↔ Codex forks, edit-an-old-prompt branches, visible-point
  rewind, manual compaction, archive/unarchive and stable provider-neutral
  session handles. Rewind is history-only and never claims to restore files.
- **Code review in the Git panel** for uncommitted changes, a base branch, a
  commit or custom instructions, delivered inline or in a separate session.
  Codex uses native review; Claude uses an equivalent read-only forked review.
- **Human approval cards for Codex**, including session-scoped grants, user vs
  automatic reviewer selection, beta permission profiles and one-shot retry of
  an exact Guardian denial. Claude and Codex now share the same visible waiting
  and question flows.
- **Provider-neutral session collaboration.** Every live Claude and Codex
  session receives the local `charon_peer` MCP, whose `list_sessions` and
  `send_message` tools route by durable `@handle` between live sessions on the
  same VPS and record delivery as an external message.
- **Session inspector in Tools:** native/display identity, context-window
  pressure, recorded turn usage, MCP servers/tools/auth/errors, skills,
  Claude commands, Codex apps and scoped sub-agent trees/transcripts.
- **Provider-native background work** in the common task bar, including Codex
  background terminals, Claude workflow/sub-agent progress, durable terminal
  reconciliation and targeted stop controls.
- **Advanced session configuration:** base/developer instructions and JSON
  output schema for both providers; Claude fallback/skills/environment; Codex
  personality, reasoning summary, service tier, provider, environment,
  ephemeral mode and bounded config overrides.
- **Rich Codex event rendering:** live plan, command output and file-patch
  deltas, compaction markers, effective-model reroutes, hooks, MCP progress,
  generated images and native thread items no longer disappear from replay.
- **Remote workspace and code intelligence:** shared tabs, lazy file tree,
  conflict-safe editor, project search, Git workspaces/branches/history/review
  and bounded remote LSP diagnostics/navigation/refactors.
- **Structured-output persistence** for Claude plus common turn-level usage
  rows, so successful schema output and final accounting survive replay.
- **In-hub sign-in for both backends.** Claude uses the hosted OAuth-code flow
  (open the URL, paste the code back — works on a headless VPS); Codex uses the
  ChatGPT device-code flow. No PTY, no callback on the VPS.
- **Persistent SSH shells** (xterm.js over a WebSocket) whose PTY lives in a
  detached holder process on the VPS: they survive both an agent restart and a
  Charon restart, and spool their output while detached.
- **Durable per-session event log** on the agent: every event gets a monotonic
  `seq`, replay resumes from a cursor instead of an in-memory ring, and log
  rotation or a corrupt line surfaces as an explicit gap banner rather than
  silently losing events.
- **Account-usage gauges** (5h / 7d windows) per VPS, with global pacing so N
  VPSes sharing one account don't hammer the endpoint.
- **Live token counter** and turn stats (step count, elapsed) while a turn runs.
- **Per-session model, fallback model and reasoning effort**, including the
  `ultracode` pseudo-effort (workflow orchestration), with an "apply now"
  restart for Claude — Codex applies them on the next turn.
- **Background-task tracking**: a bar above the input showing turns the CLI
  started on its own, plus per-sub-agent progress for workflow runs.
- **Fleet-wide freshness**: the hub compares the agent version, the committed
  `.pyz` hash and the PyPI versions of `claude-agent-sdk` / `openai-codex`, and
  offers a one-click update or auto-updates quiet VPSes.
- **Per-VPS health chips** — four axes (ssh / agent / Claude / Codex), each with
  the contextual fix, so an unusable VPS says why.
- **VPS list filtering** by name, host or project path, in both the VPS manager
  and the new-session wizard, plus path autocomplete driven by a remote
  `list_dir` RPC.
- **Session working directory in the chat header**, as a subtitle under the
  session name.
- **Inline recovery CTAs**: a "sign in to Claude" button under a bubble that
  reports an expired OAuth token, and a one-click "Continue" when the CLI cuts a
  turn mid-response.
- **Notifications**: Web Push and Telegram for permission requests, questions,
  finished turns and idle shells, with deep links back to the session or shell.
- **Import of existing Claude and Codex CLI sessions** found on a VPS, history
  included, with Codex archive state mirrored by the hub.
- **Test suites**: Vitest for the hub, stdlib `unittest` for the agent, both
  wired into CI (`npm test`, `npm run test:py`) alongside a login rate-limiter,
  replay/pagination fault-injection suites and an agent holder load test.
- Initial open-source release preparation: `LICENSE`, `README.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub issue and PR
  templates, Dependabot config.
- `Dockerfile` and `docker-compose.yml` for self-hosting.
- `GET /api/health` endpoint for reverse-proxy and container healthchecks.
- `agent/requirements.txt` declaring the Python runtime deps installed on each
  managed VPS.
- `npm run typecheck` script (`tsc --noEmit`) and matching CI job.
- CI `docker` job: builds the image, boots the full compose stack and probes
  `/api/health` **from the host** (the in-container healthcheck cannot detect a
  container-loopback bind), asserts the server runs unprivileged and that the
  mounted `~/.ssh` is writable.
- Startup preflight in the container entrypoint: warns explicitly when an SSH
  key is unreadable by the server user, has been materialised as a directory by
  a missing bind-mount source, or when no key is present at all.

### Changed

- The Tools inspector preloads with the selected session, resolves each data
  source independently and groups identity, security, resources, context, MCP
  sub-agents and recorded tool calls under collapsible headings. It shows
  explicit loading states, keeps last-good data during refresh and hides
  reconnect for healthy MCP servers.
- Session names are presentation; stable `@handles` are the routing identity.
  Native CLI titles are mirrored and displayed separately when convergence is
  pending instead of silently assuming all three values are identical.
- Provider-specific controls use one explicit capability contract. Native,
  safely adapted and unavailable operations share UI/storage where possible
  while runtime support is still detected from the agent, never guessed from a
  package version.
- **One responsive UI** at `/`: the separate mobile route tree was retired in
  favour of breakpoints and drawers, so phones run the same components.
- Full UI translation from French to English.
- Default project license is Apache 2.0.
- Scroll-up pagination is chronological (page slices of one stable order)
  instead of id-based, which used to interleave rows and drop attachments at
  page boundaries.
- `next.config.mjs` now sets standard security headers (`X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, and `Strict-Transport-Security` in production).
- Cookie session is `Secure` when `NODE_ENV=production`.
- `VAPID_SUBJECT` is now an environment variable (was previously hardcoded).
- **Docker: SSH material moved to a single directory mount**
  `./docker/ssh:/home/charon/.ssh` (was two file mounts). A file mount whose
  source doesn't exist on the host — always the case in a fresh clone, both
  paths being gitignored — is materialised by Docker as an empty *directory*
  that then shadows the key. The directory mount also persists
  `charon_known_hosts`. `CHARON_SSH_KEY` is no longer read: put the key in
  `./docker/ssh/`.
- **Docker: the image no longer sets `USER charon`.** The entrypoint runs as
  root just long enough to `chown` the bind mounts (which arrive with the
  *host's* ownership, never uid 1001) and apply the migrations, then drops to
  uid 1001 via `setpriv` for the server process. Running the container as an
  explicit user is still supported and detected (no chown, no drop).
- **Docker: `HOST` is pinned to `0.0.0.0` in `docker-compose.yml`** and
  re-forced by the entrypoint. `.env.example` ships `HOST=127.0.0.1` (correct
  for a bare-metal install behind a reverse proxy) and `env_file:` fed it
  straight to the container, where it binds the *container's* loopback: the
  published port refused every connection while the in-container healthcheck
  stayed green. Exposure is controlled by the `ports:` publication.
- README: the Docker section documents the exact procedure; the nginx example
  now includes the required `map $http_upgrade $connection_upgrade` block
  (without it every shell terminal loops on "reconnecting…").

### Fixed

- Missing context telemetry no longer labels a loaded, idle Codex thread as
  “not running”; lifecycle status and context-usage availability are displayed
  independently.
- The stdlib-only agent test suite now supplies its own tiny Pydantic test
  double for the Codex background-terminal response model, so clean CI runners
  no longer fail only because a developer machine happened to have Pydantic.
- Codex forks and newly-created external threads release the temporary
  app-server writer before the target resumes them; unmaterialized threads are
  no longer read with `includeTurns` before their first user message.
- Codex context gauges use the latest request footprint instead of lifetime
  thread totals, preventing impossible percentages far above 100%; internal
  Guardian/review/compaction workers no longer appear as user sub-agents.
- Charon restarts no longer freeze open tabs: agent connections are armed at
  process start, and the browser self-heals through a reconcile on reconnect
  plus an SSE-independent poll.
- Sessions no longer go silent after an agent update (stale client
  subscriptions are re-attached), and a mid-update hub restart no longer leaves
  sessions asleep forever.
- Replay is exact: rows are keyed by the producing event's seq, the durable
  cursor is held back on a failed write, and rotation gaps are reported.
- Phantom shells no longer loop on "reconnecting…" — the row is pruned wherever
  the agent reports the shell gone.
- Diff snapshots are stripped from session reads and served lazily, which cut
  a multi-GB/day egress leak.
- `next build` no longer opens the runtime SQLite database, which could race
  itself into "database is locked" during page-data collection.
- Codex is now installed on every VPS, and a crashed Python probe can no longer
  be mistaken for a successful one (a VPS could pass verification with neither
  backend actually installed).
- The remote `claude auth login` process is reaped on every terminal path
  instead of surviving forever on the VPS.
- An oversized tool result no longer kills the turn (the agent raises the SDK's
  per-message buffer cap).

### Security

- Secret settings (Telegram token, Claude API key, VAPID private key) are
  encrypted at rest with AES-256-GCM and masked in every API response.
- Session tokens are stored hashed (HMAC-SHA256) instead of raw.
- CSRF origin check on cookie-authenticated mutations, and an origin allow-list
  on the shell WebSocket upgrade (lax cookies don't protect handshakes).
- Login brute-force throttling with exponential lockout.
- Strict validation of SSH targets, `--` before every ssh destination, a
  Charon-scoped `known_hosts`, and a configurable private key honoured by every
  spawn site.
- CI runs a blocking `npm audit --omit=dev --audit-level=high`.

### Removed

- The PTY-based login console (superseded by the OAuth-code and device-code
  flows).
- Prototype pages and their `three.js` / `xyflow` production dependencies.
- Legacy `bridge.py` references in code and docs (the agent replaces it).
- Various development-time path hardcodings and personal references.
- Internal planning and audit documents. Their durable content — invariants,
  rejected alternatives, known footguns — lives in the code comments and the
  maintainer guide.

## How releases work

- `main` is the development branch.
- Versioned releases will use Git tags (`v0.1.0`, `v0.2.0`, …) with a
  corresponding GitHub release.
- Breaking changes are announced under a `### Breaking` heading and the
  minor version is bumped (pre-1.0 ; once 1.0 lands, breaking changes
  bump the major).
