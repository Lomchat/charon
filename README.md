# Charon

[![CI](https://github.com/Lomchat/charon/actions/workflows/ci.yml/badge.svg)](https://github.com/Lomchat/charon/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-3776AB?logo=python&logoColor=white)](https://www.python.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)

> **One browser tab to run AI coding sessions _and_ live shells across all your
> remote servers.** Charon is a self-hosted hub with **two co-equal uses**:
>
> 1. **A Claude chat/discussion hub** — launch and supervise
>    [Claude Code](https://docs.claude.com/en/docs/claude-code) /
>    [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk) sessions
>    on any SSH-reachable VPS, with token-streamed replies, a permission flow,
>    diffs and notifications.
> 2. **A persistent SSH-shell manager** — full xterm.js terminals on those same
>    boxes that **survive Charon restarts, agent restarts/updates and browser
>    closes** (the PTY lives in a detached holder on the VPS).

Everything runs from a single window. Both the sessions and the shells live in a
daemon (`charon-agent`) on each VPS, so they keep running when your laptop
sleeps, your network drops, or you restart the hub. Charon is just the control
plane.

![Charon desktop dashboard — sidebar of VPS with Claude sessions and shells, a streaming session and a permission request](./docs/screenshots/dashboard.png)

```
┌───────────────┐  HTTPS/SSE   ┌────────────────────────┐  SSH (1 per VPS)  ┌──────────────────────┐
│   Browser     │ ◄──────────► │  Charon (Next.js)      │ ◄───────────────► │  charon-agent (VPS)  │
│  sessions +   │  SSE / POST  │  - 1 SSH per VPS       │  exec: pyz        │  - asyncio Unix sock │
│  shells (1 tab)│             │  - JSON-RPC multiplex  │  --connect proxy  │  - N SDK sessions    │
│               │              │  - SQLite (charon.db)  │  stdio↔socket     │  - detached shells   │
└───────────────┘              └────────────────────────┘                   └──────────────────────┘
```

---

## The two halves

### 1 · Claude sessions — a real discussion UI

<img src="./docs/screenshots/claude-chat.png" alt="Claude session view: streamed answer, paired tool calls, and a permission card" width="48%"></img>
<img src="./docs/screenshots/mobile-chat.png" alt="Mobile session view with a permission request" width="22%"></img>

Each session is an independent `ClaudeSDKClient` running **on the VPS**, not on
your machine:

- **Token-by-token streaming** of the assistant's answer, with **collapsible
  thinking blocks** and tool calls **paired with their results** in a side panel.
- **Permission flow** — every `Edit`, `Bash`, `Write`, … pauses for your
  approval: _allow once_ / _allow always (this session)_ / _deny_. You're pinged
  by **Web Push + Telegram** when a session is waiting on you.
- **Diff capture & revert** — every edit stores a `before`/`after` snapshot; one
  click rewinds a single file.
- **Per-session model / effort**, a **todo panel**, **full-text search** across
  all history, and **`claude login` from the browser** (a TUI that proxies the
  OAuth flow over SSH).
- **Survives everything** — restart Charon, restart the agent, drop the
  network: the session keeps running and the UI reattaches with a durable replay
  of anything it missed. No more "my terminal died, my session is gone".

### 2 · Persistent SSH shells

![A persistent shell terminal running on a remote VPS, next to the Claude sessions in the sidebar](./docs/screenshots/shell.png)

Real **xterm.js** terminals, multiple per VPS, right next to your Claude
sessions:

- The **PTY + bash live in a detached holder** on the VPS — the shell survives a
  Charon restart **and** an agent restart/update. Reopen it days later and your
  scrollback is replayed from a durable per-shell log.
- WebSocket transport (binary for the hot path), instant tail-replay on
  reconnect, idle "finished" notifications, last-resize-wins across devices.
- Shared across desktop and the mobile UI.

---

## Why

Running long Claude Code sessions on a laptop is fragile: if your terminal dies,
your network drops, or your machine sleeps, the session is gone. The same is
true of an `ssh` session you forgot in a tmux you can't find. Charon moves both
into a daemon on the VPS and gives you one durable, notify-on-event window over
your whole fleet.

## Features at a glance

- **Multi-VPS dashboard** — sidebar grouped by folder → VPS → sessions & shells,
  drag-and-drop between folders, a "show paused" toggle.
- **Persistent Claude sessions** — survive Charon/agent restarts and network
  drops; auto-resume on boot, durable event-log replay on reconnect.
- **Persistent shells** — detached-holder PTYs that outlive the hub and the
  agent (see above).
- **One SSH connection per VPS**, JSON-RPC multiplexed — no per-session SSH
  spawns.
- **Streaming chat UI**, **permission flow**, **diff/revert**, **todo panel**,
  **full-text search**, **per-session model/effort**.
- **Notifications** — Web Push + Telegram on pending permissions, questions and
  turn-completions.
- **Mobile UI** — dedicated `/m/*` routes (bottom-sheets, big tap targets).
- **One-click VPS bootstrap** — detects the distro, installs Python +
  `claude-agent-sdk` + the `claude` CLI, deploys the agent zipapp, registers a
  systemd-user service (or `nohup` + cron fallback).
- **Resilient by design** — the frontend re-syncs after a hub restart without a
  manual refresh (boot-time agent arming, status reconcile, SSE auto-recovery).

## Requirements

**Charon host (where the dashboard runs):** Node.js ≥ 20, `openssl`, an `ssh`
client. SQLite is bundled via `better-sqlite3` — no system SQLite needed.

**Each target VPS:** SSH access **by key** (no password auth), Python ≥ 3.10
(for the Claude Agent SDK), and the `claude` CLI for the one-time OAuth
`claude login`. The bootstrap installer can set these up on Ubuntu/Debian (apt),
Fedora/RHEL-like (dnf), Alpine (apk) and Arch (pacman). Other Linux distros may
work but are untested; macOS/Windows/\*BSD as VPS targets are not supported.

## Quickstart

```bash
git clone https://github.com/Lomchat/charon.git
cd charon
cp .env.example .env
# Edit .env:
#   - MASTER_PASSWORD : a strong passphrase you'll remember (it's your login)
#   - generate three secrets:
#       openssl rand -hex 32   # → MASTER_SALT
#       openssl rand -hex 32   # → SESSION_SECRET
#       openssl rand -hex 32   # → SYNC_TOKEN

npm ci
npm run db:migrate
npm run build
npm start
# → http://127.0.0.1:10556
```

Open the URL, log in with your `MASTER_PASSWORD`, and you're in.

### Run with Docker

```bash
cp .env.example .env          # fill MASTER_PASSWORD + the three secrets as above
# Charon needs an SSH private key to reach your VPS. Point CHARON_SSH_KEY at it
# (mounted read-only into the container) or drop one in ./data — see
# docker-compose.yml. The SQLite DB persists in the ./data volume.
docker compose up -d --build
# → http://127.0.0.1:10556
```

### Adding your first VPS

1. Sidebar toolbar → **＋ Agent** (or the VPS settings modal) → add name, IP, SSH
   user, port, default path.
2. The VPS appears with a red dot (agent not installed). Click **install** — the
   panel streams every phase: detect OS → install Python → `claude-agent-sdk` →
   `claude` CLI → deploy agent → register service → ping (~30–90 s on a fresh box).
3. If you've never run `claude login` there, click **claude login** — a TUI opens
   in your browser, proxying the OAuth flow over SSH. Paste the URL, complete
   OAuth, come back.
4. **＋ Agent** on that VPS → pick a working directory → first prompt. Or **＋ Shell**
   for a terminal.

### Behind a reverse proxy (production)

Charon binds to `127.0.0.1:10556`. Put a TLS-terminating reverse proxy in front.
The session cookie is `Secure` when `NODE_ENV=production`, so the proxy **must**
serve HTTPS. It must also forward **SSE** (no buffering) **and** the WebSocket
**Upgrade** for shells. `GET /api/health` is an unauthenticated liveness probe
(200 when the DB is reachable, 503 otherwise). Example nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name charon.example.com;
  ssl_certificate ...; ssl_certificate_key ...;

  location / {
    proxy_pass http://127.0.0.1:10556;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # WebSocket upgrade (persistent shells)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # map: ''→'', 'upgrade'→'upgrade'
    # SSE — no buffering, long timeouts
    proxy_buffering off; proxy_cache off;
    proxy_read_timeout 1h; proxy_send_timeout 1h;
  }
}
```

A systemd unit example is in [docs/charon.service.example](./docs/charon.service.example).

### Notifications

- **Web Push** works out of the box: VAPID keys are auto-generated on first run;
  click the bell in the header to subscribe the current browser. Set
  `VAPID_SUBJECT` (a `mailto:`/`https:` identity) or override it in Settings.
- **Telegram** (optional): create a bot with @BotFather, then enter the **bot
  token** and your **chat id** in **Settings → Notifications**.
- Both are gated by a global notifications toggle in Settings.

## Environment variables

| Variable          | Required | Description                                                                                            |
| ----------------- | :------: | ------------------------------------------------------------------------------------------------------ |
| `MASTER_PASSWORD` |   yes    | Login password **and** seed for the AES key (scrypt + `MASTER_SALT`). Changing it loses encrypted data — see *Architecture notes*. |
| `MASTER_SALT`     |   yes    | scrypt salt. `openssl rand -hex 32`. Treat as a secret.                                                 |
| `SESSION_SECRET`  |   yes    | Session-cookie signing secret. `openssl rand -hex 32`.                                                  |
| `SYNC_TOKEN`      |   yes    | Bearer token gating `POST /api/sync`. `openssl rand -hex 32`.                                           |
| `DATABASE_URL`    |    no    | SQLite path. Defaults to `./data/charon.db`.                                                            |
| `HOST` / `PORT`   |    no    | Bind host/port. Default `127.0.0.1:10556`.                                                              |
| `NODE_ENV`        |    no    | `production` enables HSTS + `Secure` cookies.                                                           |
| `VAPID_SUBJECT`   |    no    | Web Push identity (`mailto:…`/`https:…`). Override-able in Settings. Default `mailto:admin@example.com`. |

## Architecture notes

The short version. The long version, with the *why*, is in
[`docs/adr-001-charon-agent.md`](./docs/adr-001-charon-agent.md); the operational
guide is in [`CLAUDE.md`](./CLAUDE.md).

- **Charon hub** (this repo): Next.js 15 App Router, React 19, SQLite via Drizzle
  + `better-sqlite3`. SSR + SSE-streamed UI. One process, single-user.
- **`charon-agent`**: a Python **stdlib-only zipapp** deployed to each VPS at
  `~/.charon/charon-agent.pyz`. Listens on a Unix socket, hosts N
  `ClaudeSDKClient` sessions and the detached shell holders, checkpoints state to
  `~/.charon/state.json` after every change.
- **Transport**: one long-running SSH per VPS, the agent invoked as
  `exec ~/.charon/charon-agent.pyz --connect` (stdio ↔ Unix socket). Backoff
  reconnect on drop.
- **Persistence & replay**: sessions survive Charon restarts (the agent keeps
  running), agent restarts (state.json restores them in `resume` mode), and
  network drops. On reconnect Charon replays exactly the events it missed from a
  **durable per-session append-only event log** (monotonic `seq` cursor); an
  in-memory ring buffer is only the fast path and is not relied on for recovery.
- **Security**: single-user (one `users` row, seeded from `MASTER_PASSWORD`).
  Cookies `HttpOnly`, `SameSite=Lax`, `Secure` in prod. Headers:
  `X-Frame-Options: DENY`, HSTS in prod, `Referrer-Policy`, `Permissions-Policy`.
  No CSP yet (Next inlines SSR scripts without a nonce — see `next.config.mjs`).
  Each VPS's Unix socket is `chmod 600` and the agent opens **no** TCP port — all
  traffic is over SSH, so your SSH key is the authorization boundary.

### About `MASTER_PASSWORD`

It is both (1) the login password and (2) the seed for the AES key that encrypts
a few sensitive settings in SQLite (the Web Push private key, etc.), via
`scrypt(MASTER_PASSWORD, MASTER_SALT)`. **Changing it without re-encrypting first
permanently loses access to those encrypted settings.** Rotation is manual today
(decrypt with old, re-encrypt with new); a helper is on the roadmap.

### About the agent `.pyz` blob

`agent/dist/charon-agent.pyz` is committed because Charon base64-pipes it to each
VPS during bootstrap. After any change to `agent/charon_agent/`, regenerate it
with `bash agent/build.sh` (CI rebuilds it on every push).

## Known quirks

- **`next build --turbopack` breaks `next start`** on Next 15.5.x (all
  `_next/static/*` 404). The `build` script does *not* pass `--turbopack`; dev
  mode does, which is fine.
- **`reactStrictMode: false`** is intentional — dev double-render duplicates SSE
  events and races the interaction queues.
- **A `.next` polluted by a crashed `next dev`** makes `next start` loop with
  *"Could not find a production build"*. Fix: `rm -rf .next && npm run build`.
- **`claude login` is per-VPS** — there is no shared OAuth (this is how the
  upstream `claude` CLI works).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Blank page, 404 on `/_next/static/*` | Built with `--turbopack`. `rm -rf .next && npm run build`. |
| `next start` loops "Could not find a production build" | A dev process polluted `.next`. Same fix. |
| Sidebar shows a red dot next to a VPS | Agent not installed/reachable. Click **install** → watch the bootstrap stream. |
| "Agent out of date" badge | Bundled `.pyz` SHA ≠ the one in DB. Click **Update agent**. |
| Shell stuck "reconnecting…" behind a proxy | The reverse proxy isn't forwarding the WebSocket `Upgrade`. See the nginx block above. |
| Session stuck on "thinking" | The SDK ignored an `interrupt`. Use **Force stop** (resumable). |
| `ensurepip is not available` during install | The VPS lacks `python3-venv`. Bootstrap auto-installs it on apt/dnf — open an issue for other distros. |

## Non-goals

- **No multi-tenant / multi-user / RBAC / SSO.** Single-user by design; fork if
  you need a team dashboard.
- **No VPS provisioning.** Charon expects VPS that already exist and are
  SSH-reachable by key.
- **No Windows / \*BSD / macOS-as-VPS support.**
- **No cloud-hosted version.** Self-hosted only.

## Contributing

Bug reports and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev
mode, migrations, the JSON-RPC protocol, and the PR flow. By participating you
agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues: follow
[SECURITY.md](./SECURITY.md) — please don't open a public issue.

The UI is English; some internal comments/docs (notably `CLAUDE.md`) are still
partly French — translation PRs welcome.

> Screenshots use 100% fictitious data (see `scripts/demo-seed.mjs` +
> `scripts/demo-shots.mjs`).

## License

[Apache 2.0](./LICENSE) © Lomchat.
