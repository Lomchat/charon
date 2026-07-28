# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial open-source release preparation : `LICENSE`, `README.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub issue and
  PR templates, Dependabot config.
- `Dockerfile` and `docker-compose.yml` for self-hosting.
- `GET /api/health` endpoint for reverse-proxy and container healthchecks.
- `agent/requirements.txt` declaring the Python runtime deps installed on
  each managed VPS.
- `npm run typecheck` script (`tsc --noEmit`) and matching CI job.
- CI `docker` job: builds the image, boots the full compose stack and probes
  `/api/health` **from the host** (the in-container healthcheck cannot detect
  a container-loopback bind), asserts the server runs unprivileged and that
  the mounted `~/.ssh` is writable.
- Startup preflight in the container entrypoint: warns explicitly when an SSH
  key is unreadable by the server user, has been materialised as a directory
  by a missing bind-mount source, or when no key is present at all.

### Changed

- Full UI translation from French to English (desktop and mobile).
- Default project license is Apache 2.0.
- `next.config.mjs` now sets standard security headers
  (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security`
  in production).
- Cookie session is `Secure` when `NODE_ENV=production`.
- `VAPID_SUBJECT` is now an environment variable (was previously
  hardcoded).
- **Docker: SSH material moved to a single directory mount**
  `./docker/ssh:/home/charon/.ssh` (was two file mounts: `${CHARON_SSH_KEY}`
  → `id_rsa` and `docker/known_hosts`). A file mount whose source doesn't
  exist on the host — which was always the case in a fresh clone, both paths
  being gitignored — is materialised by Docker as an empty *directory* that
  then shadows the key. The directory mount also persists
  `charon_known_hosts`, which the old `known_hosts` mount never did (Charon
  uses a Charon-scoped store). `CHARON_SSH_KEY` is no longer read: put the
  key in `./docker/ssh/`.
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

### Removed

- Various development-time path hardcodings and personal references.
- Legacy `bridge.py` references in code and docs (the agent replaces it).

## How releases work

- `main` is the development branch.
- Versioned releases will use Git tags (`v0.1.0`, `v0.2.0`, …) with a
  corresponding GitHub release.
- Breaking changes are announced under a `### Breaking` heading and the
  minor version is bumped (pre-1.0 ; once 1.0 lands, breaking changes
  bump the major).
