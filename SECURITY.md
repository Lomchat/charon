# Security Policy

## Supported versions

Charon is currently pre-1.0 — only the `main` branch is supported. Once a
versioned release exists, this section will list the supported lines.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting :

1. Go to the repository on GitHub.
2. Click **Security** → **Advisories** → **New draft security advisory**.
3. Fill in the details. The maintainers will be notified privately.

If for some reason GitHub Security Advisories are unavailable to you, open
a minimal public issue saying only *"Please reach out about a security
issue"* — a maintainer will provide a private channel.

### What to include

- Affected version (commit SHA if possible).
- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof-of-concept.
- Any suggested mitigation.

### Response timeline

We aim to :

- Acknowledge your report within **3 business days**.
- Provide a first assessment within **7 business days**.
- Coordinate a fix and disclosure timeline with you. Critical issues
  generally get a patch within **14 days**.

You'll be credited in the release notes unless you prefer to remain
anonymous.

## Threat model

Charon is **self-hosted, single-user, and intended to run behind a TLS
reverse proxy** (or on `localhost` only). The threat model assumes :

- The operator controls the host.
- An attacker on the network cannot reach Charon directly (only via the
  reverse proxy with TLS).
- An attacker who learns the `MASTER_PASSWORD` has full access — there is
  no MFA. Choose a strong passphrase and store it in a password manager.
- The host's filesystem is trusted. Two settings are hardened against a
  stolen DB copy — secret settings (Telegram bot token, Anthropic API key,
  VAPID private key) are stored as AES-256-GCM `enc:v1:` blobs keyed by
  `scrypt(MASTER_PASSWORD, MASTER_SALT)`, and session tokens are stored as
  `HMAC-SHA256(SESSION_SECRET, token)` rather than raw. Everything else is
  plaintext on disk : session transcripts and messages in SQLite, the agent
  `.pyz`, and the SSH private key (whose file permissions are what `ssh`
  requires). At-rest encryption protects a leaked database file, not the
  live host — an attacker with the host's env has the key too.
- Each VPS that Charon talks to is trusted. Charon runs arbitrary `bash`
  and `claude` commands on every VPS it manages, by design — the agent
  receives RPC calls over a `chmod 600` Unix socket reachable only via
  SSH-by-key. Anyone with the SSH key effectively has root-equivalent
  access on the VPS.

### Out of scope

The following are explicitly **not** considered vulnerabilities :

- Anyone with the `MASTER_PASSWORD` accessing the dashboard.
- Anyone with the SSH key controlling the managed VPS.
- DoS against the SSE endpoints by a logged-in user.
- The `.pyz` agent being deployed as root on the VPS (this is the
  expected deployment topology).

### In scope

We're interested in reports about :

- Authentication bypass (cookie forgery, scrypt misuse, etc.).
- Cross-site request forgery on state-changing endpoints.
- Shell command injection on inputs that reach `sshExec` without
  `shQuote`.
- Path traversal or unintended file access in the endpoints that take a
  user-supplied path or reach the filesystem of a managed VPS — notably
  `GET /api/vps/[id]/fs?path=` (directory listing for the path
  autocomplete), `POST /api/claude/sessions/[id]/revert` (writes/deletes a
  file over SSH) and `GET /api/claude/sessions/[id]/export` (dumps a full
  transcript). These are authenticated, but we want to hear about any way
  to escape their intended scope.
- Anything that lets an unauthenticated visitor learn about the existence
  or contents of sessions / VPS / settings.
- Anything that lets a logged-in user escalate beyond the documented
  single-user model.

Thanks for helping keep Charon safe.
