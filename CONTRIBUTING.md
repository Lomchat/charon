# Contributing to Charon

Thanks for taking the time to contribute. Charon is a small project and the
following is the minimum you need to get productive.

## Development setup

```bash
git clone https://github.com/Lomchat/charon.git
cd charon
cp .env.example .env  # fill in MASTER_PASSWORD, MASTER_SALT, SESSION_SECRET, SYNC_TOKEN
npm ci
npm run db:migrate
npm run dev           # custom Next server on http://127.0.0.1:10556
```

`npm run dev` (like `npm start`) runs `node server.js`, a custom Next server —
it serves the app *and* handles the shell WebSocket upgrade, which App Router
route handlers can't do. `HOST` / `PORT` override the defaults.

You'll also need at least one VPS to test against. A throwaway Ubuntu/Debian
box with a key in `authorized_keys` is enough.

## Repo map

- `app/` — Next.js App Router : UI components and API routes. The UI is a
  single responsive page at `/` (desktop 3-col → tablet/phone drawers); there
  is no separate mobile tree anymore.
  - `app/api/**/route.ts` — every API endpoint.
- `lib/` — server-side logic (DB, auth, crypto, agent client pool, bootstrap).
- `agent/charon_agent/` — Python daemon that runs on each VPS.
- `agent/tests/` — stdlib `unittest` suites for the daemon.
- `agent/dist/charon-agent.pyz` — the built zipapp. **It is committed** and CI
  diffs it, so any `agent/` change must be rebuilt and committed with it.
- `server.js` — the custom Next server (HTTP + the shell WebSocket upgrade at
  `/api/shells/<id>/ws`, which authenticates itself against SQLite because
  middleware doesn't run on upgrades).
- `middleware.ts` — auth gate on every route plus the CSRF `Origin` check.
- `tests/` — Vitest suites for the hub (see [Tests](#tests)).
- `drizzle/` — generated SQL migrations + the migration journal.
- `scripts/` — `migrate.mjs` (apply migrations), `check-protocol-sync.mjs`
  (prebuild check that the Python and TypeScript JSON-RPC method lists agree).
- `docs/` — architecture decisions (ADR-001).
- `docker/` — container entrypoint + the bind-mounted runtime SSH material
  (`docker/ssh`, gitignored except for its `.gitkeep`).
- `.github/workflows/ci.yml` — the exact gates your PR has to pass.

The canonical spec of the JSON-RPC protocol lives in the code itself:
`agent/charon_agent/protocol.py` (`METHODS`) mirrored by
`lib/server/agent/types.ts` — `scripts/check-protocol-sync.mjs` fails the build
on any drift. The DB schema is `lib/db/schema.ts`. Maintainers additionally
keep a private operational guide (`CLAUDE.md`, gitignored) that is *not* part
of the public repo — nothing in it is required to contribute.

## Common tasks

### Add a database migration

```bash
# Edit lib/db/schema.ts
npm run db:generate    # → drizzle/NNNN_<name>.sql
# Inspect the generated SQL — drizzle sometimes outputs redundant statements.
npm run db:migrate     # applies it
git add drizzle/*.sql drizzle/meta/  # commit BOTH .sql and the snapshot
```

### Add a JSON-RPC method

A method exists in three places at once :

1. Python handler in `agent/charon_agent/server.py` (the dispatch table) and
   the helper in `session.py`.
2. The method name added to `METHODS` in `agent/charon_agent/protocol.py`.
3. TypeScript mirror : `lib/server/agent/types.ts` (the `AgentMethodName`
   union, and event types if you also added events), and a wrapper in
   `lib/server/agent/AgentClient.ts`.

After editing : bump `agent/charon_agent/__init__.py:__version__`, then
`bash agent/build.sh` to regenerate `agent/dist/charon-agent.pyz`.

The prebuild step `scripts/check-protocol-sync.mjs` will fail the build if
the Python `METHODS` set and the TS `AgentMethodName` union disagree — so
you'll know immediately if you forgot one side.

### Add an API route

1. Create `app/api/<path>/route.ts`.
2. Add a wrapper in `lib/api.ts` for the client side, and typed bodies /
   responses in `lib/types/api.ts`.

### Modify the UI

State mostly lives in `app/ClaudePanel.tsx` (the single responsive shell) and
`app/ClaudeSessionView.tsx` (the chat view). Both consume a shared session
hook, `useClaudeSessionStream`, that handles the SSE stream and exposes
session state + actions. Look at it before plumbing yet another `useEffect` —
chances are the hook already exposes what you need.

## Coding conventions

- **TypeScript everywhere** for the hub. No `any` in new code (the existing
  codebase has a few, please don't add more).
- **Format / lint** : no enforced formatter today. Match the surrounding
  file. Two-space indentation, semicolons, single quotes for strings.
- **Commits** : descriptive subject in imperative ("fix permission queue
  race"), short body if context is needed. No specific convention — match
  the existing history.
- **PR titles** : same.
- **Comments** : English preferred for new code. Existing comments are
  still partly French ; translating them is a welcome separate PR.

## Tests

Two suites, both gated by CI :

```bash
npm test           # Vitest — the hub (tests/**/*.test.ts + lib/**/*.test.ts)
npm run test:watch # same, in watch mode
npm run test:py    # Python stdlib unittest — the agent (agent/tests/)
```

`npm run test:py` picks the newest `python3.13…3.10` on your `PATH`; no venv
or third-party package is needed, the agent is stdlib-only.

Vitest covers the pure server/runtime modules — event-log replay identity,
message-window pagination, secrets at rest, auth migration, login
rate-limiting, bootstrap probe parsing. The Python suite covers the durable
event log, state load/save, the protocol table and a daemon integration
smoke test.

**Add tests with your change** : a regression test for a bug fix, coverage
for new pure logic. Put hub tests in `tests/` (or next to the module as
`lib/**/*.test.ts` — both are picked up by `vitest.config.ts`) and agent
tests in `agent/tests/test_*.py`. Anything needing the Next request
lifecycle or a live VPS isn't unit-testable here; describe your manual
verification in the PR instead.

## Submitting a PR

1. Fork, branch from `main`.
2. Make your changes. Try to keep PRs focused — one logical change per PR.
3. If you change observable behaviour (JSON-RPC protocol, DB schema, API
   shape, layout, build config, env vars, deployment, agent lifecycle),
   **describe it in the PR body** and add a `CHANGELOG.md` entry under
   `[Unreleased]`. A maintainer mirrors it into the private operational
   guide — you don't have that file and aren't expected to touch it.
4. Run the same gates CI does :

   ```bash
   npm run typecheck                              # tsc --noEmit
   npm test && npm run test:py                    # both suites
   DATABASE_URL=/tmp/charon-ci.db npm run db:migrate   # migrations on a fresh DB
   npm run build                                  # protocol-sync check + Next build
   bash agent/build.sh                            # only if you touched agent/
   git diff --exit-code agent/dist/charon-agent.pyz   # must be clean
   ```

   The last two matter : `agent/dist/charon-agent.pyz` is **committed** and
   the build is byte-reproducible, so a change under `agent/` without a
   rebuilt-and-committed `.pyz` turns CI red. CI also runs a blocking
   `npm audit --omit=dev --audit-level=high` and a Docker job that boots the
   compose stack.
5. Open the PR. Link to any related issue.

If your change is architectural (touches the agent protocol, the
persistence model, the SSH transport), consider opening an issue first to
discuss the approach before writing code.

## Reporting bugs

Open an issue using the bug report template. Include :

- Charon version (commit SHA).
- Node and Python versions.
- VPS distro and version.
- Steps to reproduce, observed vs expected.
- Relevant `journalctl -u charon` or `~/.charon/agent.log` lines.

## Security

**Do not** open a public issue for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for the disclosure policy.
