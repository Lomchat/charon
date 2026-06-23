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
npm run dev           # turbopack dev server on http://127.0.0.1:10556
```

You'll also need at least one VPS to test against. A throwaway Ubuntu/Debian
box with a key in `authorized_keys` is enough.

## Repo map

- `app/` — Next.js App Router : UI components and API routes. The UI is a
  single responsive page at `/` (desktop 3-col → tablet/phone drawers); there
  is no separate mobile tree anymore.
  - `app/api/**/route.ts` — every API endpoint.
- `lib/` — server-side logic (DB, auth, crypto, agent client pool, bootstrap).
- `agent/charon_agent/` — Python daemon that runs on each VPS.
- `drizzle/` — generated SQL migrations + the migration journal.
- `scripts/` — `migrate.mjs` (apply migrations), `check-protocol-sync.mjs`
  (prebuild check that the Python and TypeScript JSON-RPC method lists agree).
- `docs/` — architecture decisions (ADR-001).
- [`CLAUDE.md`](./CLAUDE.md) — operational guide. The file is verbose but it
  is the single source of truth for the JSON-RPC protocol, DB schema, the
  list of known footguns, and the post-change checklist.

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

There is currently no automated test suite. A Vitest setup is on the
roadmap. If you fix a bug, a regression test is welcome (we'll bootstrap
the test infrastructure on the first PR that needs it).

## Submitting a PR

1. Fork, branch from `main`.
2. Make your changes. Try to keep PRs focused — one logical change per PR.
3. If you change anything documented in `CLAUDE.md` (protocol, schema, API
   routes, infra), update `CLAUDE.md` in the same commit. The checklist at
   the top of that file lists every section that may need an update.
4. Run `npm run build` locally — it covers `tsc --noEmit`, the protocol
   sync check, and the Next.js build.
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
