# Contributing to Charon

Thanks for contributing. This is the minimum you need to be productive.

## Development setup

```bash
git clone https://github.com/Lomchat/charon.git
cd charon
cp .env.example .env  # fill in MASTER_PASSWORD, MASTER_SALT, SESSION_SECRET, SYNC_TOKEN
npm ci
npm run db:migrate
npm run dev           # http://127.0.0.1:10556
```

`npm run dev` (like `npm start`) runs `server.js`, a custom Next server that also
handles the shell WebSocket upgrade (App Router routes can't). `HOST` / `PORT`
override the defaults. You also need one VPS to test against: a throwaway
Ubuntu/Debian box with your key in `authorized_keys` is enough.

## Repo map

- `app/` — Next.js App Router: one responsive UI at `/`, plus `app/api/**/route.ts`.
- `lib/` — server logic (DB, auth, crypto, agent client pool, bootstrap) and
  shared types.
- `agent/charon_agent/` — the Python daemon run on each VPS; `agent/tests/` its
  `unittest` suites; `agent/dist/charon-agent.pyz` the built zipapp,
  **committed** and diffed by CI.
- `server.js` — custom server; the shell WebSocket at `/api/shells/<id>/ws`
  authenticates against SQLite itself (middleware doesn't run on upgrades).
- `middleware.ts` — auth gate plus the CSRF `Origin` check.
- `tests/` — Vitest suites for the hub.
- `drizzle/` — SQL migrations + journal.
- `scripts/` — `migrate.mjs`, the prebuild `check-protocol-sync.mjs`, CI's
  `check-agent-version-bump.mjs`, smoke and demo-capture scripts.
- `docs/` — ADR-001, screenshot guide, systemd example.
- `docker/` — entrypoint + the bind-mounted `docker/ssh` (gitignored).
- `.github/workflows/ci.yml` — the gates your PR must pass.

The JSON-RPC spec is the code: `agent/charon_agent/protocol.py` (`METHODS`)
mirrored by `lib/server/agent/types.ts`; the build fails on drift. The DB schema
is `lib/db/schema.ts`. Maintainers keep a private operational guide; nothing in
it is required to contribute.

## Common tasks

### Add a database migration

```bash
# edit lib/db/schema.ts
npm run db:generate                   # → drizzle/NNNN_<name>.sql — inspect it
npm run db:migrate
git add drizzle/*.sql drizzle/meta/   # commit BOTH
```

### Add a JSON-RPC method

1. Handler in `agent/charon_agent/server.py`, routed through exactly one of
   `_META_METHODS`, `_SESSION_METHODS` or `_SHELL_METHODS` (helpers live in the
   session modules, `shell.py`, `fsnav.py`, `filetools.py`, `git.py`, `lsp.py`…).
2. The name in `METHODS` (`agent/charon_agent/protocol.py`).
3. The TypeScript mirror: `AgentMethodName` (and event types) in
   `lib/server/agent/types.ts`, a wrapper in `lib/server/agent/AgentClient.ts`.

Then bump `__version__` in `agent/charon_agent/__init__.py` and run
`bash agent/build.sh`. Tests assert `METHODS` is exactly the union of the
dispatch sets; the prebuild check asserts Python and TypeScript agree.

### Add an API route

`app/api/<path>/route.ts`, a client wrapper in `lib/api.ts`, typed bodies in
`lib/types/api.ts`.

### Modify the UI

State mostly lives in `app/HubPanel.tsx` (the shell) and
`app/SessionView.tsx` (the chat), which share the `useSessionStream`
hook. Check it before adding another `useEffect`.

## Conventions

- **TypeScript** for the hub; no new `any`.
- **Formatting**: no enforced formatter — match the file (two spaces,
  semicolons, single quotes).
- **Commits / PR titles**: imperative subject ("fix permission queue race"),
  short body if needed.
- **Comments**: English for new code; some existing comments are French.
- **Docs**: `README.md` for user-visible features, an ADR when an architectural
  decision changes. Stale docs are bugs.

## Tests

```bash
npm test            # Vitest — tests/**/*.test.ts + lib/**/*.test.ts
npm run test:watch
npm run test:py     # stdlib unittest — agent/tests/ (newest python3.13…3.10)
```

Add a regression test with a bug fix and coverage for new pure logic. What needs
the Next request lifecycle or a live VPS isn't unit-testable: describe your
manual verification in the PR.

## Submitting a PR

1. Fork, branch from `main`, keep the PR to one logical change.
2. If you change observable behaviour (protocol, schema, API shape, build,
   env vars, deployment, agent lifecycle), say so in the PR body.
3. Run the CI gates:

   ```bash
   npm run typecheck
   npm test && npm run test:py
   DATABASE_URL=/tmp/charon-ci.db npm run db:migrate   # fresh DB
   npm run build                                        # protocol sync + Next build
   bash agent/build.sh                                  # if you touched agent/
   git diff --exit-code agent/dist/charon-agent.pyz     # must be clean
   ```

   The pyz build is byte-reproducible; an `agent/` change without a bumped
   `__version__` and a rebuilt, committed pyz fails CI. CI also runs a blocking
   `npm audit --omit=dev --audit-level=high` and a Docker job.

   On an installed checkout, `npm run build` also migrates the database and
   triggers the local auto-deploy: use an isolated checkout and database if you
   don't mean to deploy.
4. Open the PR and link related issues. For architectural changes (protocol,
   persistence, SSH transport), open an issue first.

## Reporting bugs

Use the bug report template with: commit SHA, Node and Python versions, VPS
distro, steps to reproduce (observed vs expected), and relevant
`journalctl -u charon` or `~/.charon/agent.log` lines.

## Security

**Do not** open a public issue for vulnerabilities: see [SECURITY.md](./SECURITY.md).
