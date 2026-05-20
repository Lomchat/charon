# Charon · Claude Code session hub

[![CI](https://github.com/Lomchat/charon/actions/workflows/ci.yml/badge.svg)](https://github.com/Lomchat/charon/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-3776AB?logo=python&logoColor=white)](https://www.python.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)

> Self-hosted web hub for orchestrating
> [Claude Code](https://docs.claude.com/en/docs/claude-code) /
> [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk) sessions
> across multiple SSH-accessible VPS — from a single browser window.

Charon is a single-user admin dashboard that lets you launch and supervise
Claude coding sessions on remote machines. Each session runs an independent
`ClaudeSDKClient` inside a per-VPS daemon — they survive Charon restarts,
network drops and browser closes. You stay on a single tab, switch between
projects on different boxes, watch streamed responses, approve permissions,
read diffs, and run ad-hoc SSH shells side by side.

```
┌───────────────┐  HTTPS/SSE   ┌────────────────────────┐  SSH (1 per VPS)  ┌──────────────────────┐
│   Browser     │ ◄──────────► │  Charon (Next.js)      │ ◄───────────────► │  charon-agent (VPS)  │
│  ClaudePanel  │  SSE / POST  │  - 1 SSH per VPS       │  exec: pyz        │  - asyncio Unix sock │
│               │              │  - JSON-RPC multiplex  │  --connect proxy  │  - N SDK sessions    │
│               │              │  - SQLite (charon.db)  │  stdio↔socket     │  - state.json        │
└───────────────┘              └────────────────────────┘                   └──────────────────────┘
```

## Why

Running long Claude Code sessions on a laptop is fragile : if your terminal
dies, your network drops, or your machine sleeps, the session is gone. Charon
moves the session into a daemon (`charon-agent`) that lives on the VPS itself
— Charon is just the control plane. Sessions persist independently of Charon
*and* independently of the agent (state is checkpointed to `~/.charon/
state.json` after every change). Tooling on top : diffs with revert, a todo
panel, web push + Telegram notifications when a permission is awaiting your
attention, full-text search across history.

## Features

- **Multi-VPS, multi-session dashboard** — sidebar grouped by folder → VPS →
  sessions/shells. Drag-and-drop between folders.
- **Persistent sessions** — survive Charon restart, network drops and SDK
  reconnects. Auto-resume on boot.
- **One SSH connection per VPS**, JSON-RPC multiplexed over its stdio. No
  per-session SSH spawns.
- **Streaming UI** — assistant text streamed token-by-token, tool calls and
  their results paired in a side panel, thinking blocks collapsible.
- **Permission flow** — every `Edit`, `Bash`, `Write`, etc. asks for
  permission ; allow once / allow always / deny. Telegram + web-push notify
  when a permission is awaiting you.
- **Diff revert** — every edit captures `before`/`after` snapshots ; one
  click rewinds a single file.
- **Ad-hoc SSH shells** — full xterm.js terminals next to your Claude
  sessions, multi per VPS.
- **`claude login` from the UI** — a TUI inside the browser that proxies
  Claude Code's OAuth flow via SSH.
- **Mobile UI** — dedicated `/m/*` routes optimized for portrait, with
  bottom-sheets and large tap targets.
- **Bootstrap installer** — onboard a fresh VPS in one click : detects the
  distro, installs Python and `claude-agent-sdk`, deploys the agent zipapp,
  registers a systemd-user service (or falls back to `nohup` + cron).
- **Full-text search** across every message ever sent or received.

## Requirements

### On the Charon host (where the dashboard runs)

- **Node.js ≥ 20** (LTS recommended)
- **`openssl`** for generating secrets
- **`ssh` client** — Charon spawns SSH to talk to each VPS
- **SQLite is bundled** via `better-sqlite3` — no system SQLite needed

### On each target VPS

- **SSH access by key** (Charon does not handle password auth)
- **Python ≥ 3.10** (the Claude Agent SDK requires it)
- **`claude` CLI** for the one-time OAuth `claude login`

Charon's bootstrap installer can install Python, `claude-agent-sdk`, and the
`claude` CLI on the following distros : Ubuntu / Debian (apt), Fedora /
RHEL-like (dnf), Alpine (apk), Arch (pacman). Other Linux distros may work
but are untested. macOS / Windows / *BSD as VPS targets are not supported.

## Quickstart

```bash
git clone https://github.com/Lomchat/charon.git
cd charon

# 1) Fill the .env (see "Environment variables" below)
cp .env.example .env
# Edit .env :
#   - set MASTER_PASSWORD to a strong passphrase you'll remember
#   - generate the three secrets :
#       openssl rand -hex 32   # → MASTER_SALT
#       openssl rand -hex 32   # → SESSION_SECRET
#       openssl rand -hex 32   # → SYNC_TOKEN

# 2) Install deps and migrate the DB
npm ci
npm run db:migrate

# 3) Build and start
npm run build
npm start
# → http://127.0.0.1:10556
```

Open the URL, log in with your `MASTER_PASSWORD`, and you're in.

### Adding your first VPS

1. Top-left menu → **VPS settings** → **Add VPS**. Provide name, IP, SSH
   user, port, default path.
2. Once added, the sidebar shows the VPS with a red dot (agent not
   installed). Click the install icon next to it.
3. The install panel streams every phase live : detect OS → install Python
   → install `claude-agent-sdk` → install `claude` CLI → deploy the agent
   → register the systemd service → ping. Roughly 30 to 90 seconds on a
   fresh box.
4. If you've never run `claude login` on that VPS, the panel will tell you
   — click "Setup login" to open a TUI in your browser that proxies
   `claude login` over SSH. Paste the URL in your browser, complete OAuth,
   come back to Charon.
5. Right-click the VPS → **New session** → pick a working directory →
   first prompt.

### Behind a reverse proxy (production)

Charon binds to `127.0.0.1:10556`. Put any reverse proxy in front of it
that terminates TLS. The session cookie is set with `Secure` when
`NODE_ENV=production`, so make sure your proxy actually serves HTTPS or
you'll be unable to log in. Example nginx :

```nginx
server {
  listen 443 ssl http2;
  server_name charon.example.com;
  ssl_certificate ...;
  ssl_certificate_key ...;

  location / {
    proxy_pass http://127.0.0.1:10556;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # SSE — disable buffering and keep connections alive
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }
}
```

A systemd unit example is in [docs/charon.service.example](./docs/charon.service.example).

## Environment variables

| Variable          | Required | Description                                                                                               |
| ----------------- | :------: | --------------------------------------------------------------------------------------------------------- |
| `MASTER_PASSWORD` |   yes    | Login password **and** seed for the AES key (via scrypt + `MASTER_SALT`). Changing it loses encrypted data ; see *Architecture notes* below. |
| `MASTER_SALT`     |   yes    | scrypt salt. Generate with `openssl rand -hex 32`. Treat as a secret.                                     |
| `SESSION_SECRET`  |   yes    | Signs session cookies. Generate with `openssl rand -hex 32`.                                              |
| `SYNC_TOKEN`      |   yes    | Bearer token gating `POST /api/sync`. Generate with `openssl rand -hex 32`.                               |
| `DATABASE_URL`    |    no    | Path to the SQLite DB. Defaults to `./data/charon.db`.                                                    |
| `HOST`            |    no    | Bind host. Defaults to `127.0.0.1`.                                                                       |
| `PORT`            |    no    | Bind port. Defaults to `10556`.                                                                           |
| `NODE_ENV`        |    no    | Set to `production` to enable HSTS + `Secure` cookies.                                                    |
| `VAPID_SUBJECT`   |    no    | Web Push subject (`mailto:...` or `https://...`). Override-able from the Settings UI. Defaults to `mailto:admin@example.com`. |

## Architecture notes

A short version. The long version, with the *why*, is in
[`docs/adr-001-charon-agent.md`](./docs/adr-001-charon-agent.md) and the
operational guide is in [`CLAUDE.md`](./CLAUDE.md).

- **Charon hub** (this repo) : Next.js 15 App Router, React 19, SQLite via
  Drizzle + `better-sqlite3`. Server-rendered + SSE-streamed UI. One
  process, single-user.
- **`charon-agent`** : Python stdlib zipapp (~36 KB) deployed to each VPS at
  `~/.charon/charon-agent.pyz`. Listens on a Unix socket, runs N `ClaudeSDKClient`
  sessions, persists state to `~/.charon/state.json` after every change.
- **Transport** : one long-running SSH per VPS, with the agent invoked as
  `exec ~/.charon/charon-agent.pyz --connect` — its stdio is a JSON-RPC pipe
  to the Unix socket. Backoff reconnect on drop.
- **Persistence** : sessions survive Charon restarts (the agent keeps
  running), agent restarts (state.json restores them in `resume` mode), and
  network drops (reconnect with replay of the agent-side ring buffer).
- **Security** : single-user (the `users` table holds one row, seeded from
  `MASTER_PASSWORD`). Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in
  prod. Standard headers : `X-Frame-Options: DENY`, HSTS in prod,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
  No CSP yet (Next inlines SSR scripts without a nonce — see comment in
  `next.config.mjs`). The Unix socket on each VPS is `chmod 600` and the
  agent never opens any TCP port — all traffic is over SSH.

### About `MASTER_PASSWORD`

It plays two roles : (1) the login password, and (2) the seed for the AES
key that encrypts a small number of sensitive settings in SQLite (web-push
private key, etc.). The derivation is `scrypt(MASTER_PASSWORD, MASTER_SALT)`.
**Changing the password without re-encrypting first will permanently
lose access to any encrypted setting.** If you want to rotate it, you
currently have to do that manually (decrypt with old, re-encrypt with new).
A `npm run rotate-password` helper is on the roadmap.

### About the agent `.pyz` blob

`agent/dist/charon-agent.pyz` is committed to the repo because Charon
base64-pipes it to each VPS during bootstrap. After any change to
`agent/charon_agent/`, regenerate it with :

```bash
bash agent/build.sh
```

The CI rebuilds it on every push.

## Known quirks

- **`next build --turbopack` breaks `next start`** on Next 15.5.x — all
  `_next/static/*` 404. The `build` script in `package.json` does *not* pass
  `--turbopack` for this reason. Dev mode (`npm run dev`) does, and that's
  fine.
- **`reactStrictMode: false`** in `next.config.mjs` is intentional. Dev
  double-render duplicates SSE events and races on the interaction queues
  (permission popups, etc.).
- **A `.next` polluted by a crashed `next dev`** will cause `next start` to
  loop with *"Could not find a production build"*. Fix : `rm -rf .next &&
  npm run build`.
- **`claude login` is per-VPS** — there's no shared OAuth across VPS, this
  is how the upstream `claude` CLI works.

## Troubleshooting

| Symptom                                                   | Fix                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Site loads but blank — 404 on `/_next/static/*`           | Built with `--turbopack` ; see *Known quirks*. `rm -rf .next && npm run build`.                  |
| `next start` loops with "Could not find a production build" | A dev process polluted `.next`. Same fix.                                                        |
| Sidebar shows red dot next to a VPS                       | Agent not installed or not reachable. Click the install icon → watch the bootstrap stream.       |
| "Agent out of date" badge                                 | The `.pyz` SHA in DB doesn't match the bundled one. Click **Update agent** in the install panel. |
| Session stuck on "thinking" forever                       | The SDK ignored an `interrupt` (this happens). Use **Force stop** in the header (red button).    |
| Permission popup never appears                            | Check the session's `permission_mode` in the header — `auto` skips popups.                       |
| `ensurepip is not available` during install               | The VPS is missing the OS `python3-venv` package. Bootstrap auto-installs it for apt/dnf — open an issue for other distros. |

## Non-goals

These are explicit *won't-do*s to set expectations :

- **No multi-tenant / multi-user / RBAC / SSO.** Charon is single-user by
  design. If you need a team dashboard, fork.
- **No VPS provisioning.** Charon expects VPS that already exist and are
  SSH-reachable by key. Use Terraform / Pulumi / your provider's UI for
  that step.
- **No Windows or *BSD support** for the VPS side. macOS-as-VPS is also
  out of scope.
- **No cloud-hosted version.** This is self-hosted only.

## Contributing

Bug reports and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for
how to run the project in dev mode, add a migration, modify the JSON-RPC
protocol, and submit a PR. By participating you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md).

Security issues : please follow the disclosure policy in
[SECURITY.md](./SECURITY.md) — do **not** open a public issue.

The UI is currently English. Comments and a few internal docs (notably
`CLAUDE.md`) are still partially French — translation PRs welcome.

## License

[Apache 2.0](./LICENSE) © Lomchat.
