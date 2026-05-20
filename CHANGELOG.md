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
