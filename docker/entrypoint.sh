#!/usr/bin/env sh
# Container entrypoint. Runs once per container start, AS ROOT, then drops to
# the unprivileged `charon` user (uid 1001) for the actual server process.
#
# Why root-then-drop instead of `USER charon` in the Dockerfile: every path
# that matters at runtime comes from a HOST BIND MOUNT (./data, ./docker/ssh),
# and a bind mount arrives with the HOST's ownership — which is almost never
# uid 1001. With `USER charon` the entrypoint had no way to repair that, so
# the first symptom was an opaque SQLITE_CANTOPEN or a silent ssh "permission
# denied" on every VPS. Running as root just long enough to chown the mounts
# and preflight the classic misconfigurations turns those into ONE readable
# line before the server ever starts.
#
# What it does:
#   - Forces a container-usable HOST (see the loopback guard below).
#   - Ensures/repairs the data dir and the ssh dir, applies Drizzle migrations.
#   - Preflights the SSH private keys (directory? unreadable? bad perms?).
#   - Hands off to `node server.js` (the Dockerfile CMD — the custom server
#     with the WebSocket shell bridge; NOT `next start`) as uid 1001.
set -e

CHARON_UID=1001
CHARON_GID=1001
SSH_DIR=/home/charon/.ssh

log() { echo "[charon] $*"; }
warn() { echo "[charon] WARNING: $*" >&2; }

am_root() { [ "$(id -u)" = "0" ]; }

# Privilege drop. Both candidates ship in util-linux (Essential on Debian, and
# the Dockerfile installs it explicitly). setpriv is preferred: no PAM, no
# intermediate shell, it execs in place so signals from tini reach node
# directly. NO `su` fallback on purpose — its argv handling under `-c` is
# ambiguous enough to silently run the wrong thing.
#
# If the container was started as a non-root user already (`docker run -u`, a
# compose `user:` override), both helpers degrade to a plain passthrough.
DROP_CMD=''
if am_root; then
  if command -v setpriv >/dev/null 2>&1; then
    DROP_CMD="setpriv --reuid=$CHARON_UID --regid=$CHARON_GID --clear-groups --no-new-privs"
  elif command -v runuser >/dev/null 2>&1; then
    DROP_CMD="runuser -u charon --"
  else
    echo "[charon] FATAL: neither setpriv nor runuser found — refusing to run the server as root." >&2
    exit 1
  fi
fi

run_as_charon() {
  if [ -z "$DROP_CMD" ]; then "$@"; else $DROP_CMD "$@"; fi
}

exec_as_charon() {
  if [ -z "$DROP_CMD" ]; then exec "$@"; else exec $DROP_CMD "$@"; fi
}

# --------------------------------------------------------------- bind address
# `.env.example` ships HOST=127.0.0.1 — correct for a bare-metal install behind
# a reverse proxy, FATAL in a container: it binds the CONTAINER's loopback, so
# the published port answers nothing while the HEALTHCHECK (which curls
# 127.0.0.1 from INSIDE) stays green. docker-compose.yml already pins
# HOST=0.0.0.0 in `environment:` (which wins over `env_file:`); this is the
# belt to that suspender for a bare `docker run --env-file .env`.
# Exposure is controlled by the `ports:` publication (127.0.0.1:10556 by
# default), never by this value.
case "${HOST:-}" in
  127.* | localhost | ::1 | '[::1]')
    warn "HOST=$HOST binds the container's loopback only — the published port would refuse every connection. Forcing HOST=0.0.0.0 (keep the host-side publication bound to 127.0.0.1 instead)."
    HOST=0.0.0.0
    export HOST
    ;;
esac

# ------------------------------------------------------------------- data dir
: "${DATABASE_URL:=./data/charon.db}"
DATA_DIR="$(dirname "$DATABASE_URL")"
mkdir -p "$DATA_DIR"
if am_root; then
  chown -R "$CHARON_UID:$CHARON_GID" "$DATA_DIR" 2>/dev/null \
    || warn "could not chown $DATA_DIR to $CHARON_UID:$CHARON_GID — if the server fails with SQLITE_CANTOPEN, run: sudo chown -R $CHARON_UID:$CHARON_GID ./data"
fi

# -------------------------------------------------------------------- ssh dir
# Charon shells out to `ssh` for every VPS connection and persists host keys in
# ~/.ssh/charon_known_hosts (a Charon-scoped trust store, cf. sshShared.js), so
# the directory must be WRITABLE by uid 1001 — a bind mount from the host
# usually isn't.
if am_root; then
  mkdir -p "$SSH_DIR" 2>/dev/null || true
  chown "$CHARON_UID:$CHARON_GID" "$SSH_DIR" 2>/dev/null \
    || warn "could not chown $SSH_DIR — host keys won't persist across restarts (degraded, not fatal: StrictHostKeyChecking=accept-new re-accepts them)."
  chmod 700 "$SSH_DIR" 2>/dev/null || true
fi

# Preflight the identities ssh will try by default. A NON-DEFAULT key name is
# fine too — point Settings → "SSH key (path on the hub server)" at
# /home/charon/.ssh/<name>.
key_count=0
for key in "$SSH_DIR"/id_rsa "$SSH_DIR"/id_ecdsa "$SSH_DIR"/id_ed25519; do
  [ -e "$key" ] || continue
  if [ -d "$key" ]; then
    # Docker materialises a missing bind-mount SOURCE as an empty directory —
    # the classic "my key mount is a folder" trap.
    warn "$key is a DIRECTORY, not a key. Something bind-mounted a path that doesn't exist on the host. Remove it and copy a real private key in: install -m 600 ~/.ssh/id_ed25519 ./docker/ssh/"
    continue
  fi
  key_count=$((key_count + 1))
  if am_root; then
    # Best effort: a read-only mount refuses both, and that's fine as long as
    # uid 1001 can read the file — which is what we verify right after.
    chown "$CHARON_UID:$CHARON_GID" "$key" 2>/dev/null || true
    chmod 600 "$key" 2>/dev/null || true
  fi
  if ! run_as_charon test -r "$key" 2>/dev/null; then
    warn "$key is NOT READABLE by uid $CHARON_UID (a read-only bind mount keeps the host's ownership). Every VPS connection will fail. Fix on the host: sudo chown $CHARON_UID:$CHARON_GID <keyfile> && chmod 600 <keyfile>"
  fi
done
if [ "$key_count" = "0" ]; then
  log "no SSH key found in $SSH_DIR — add one before connecting a VPS (see README § Run with Docker)."
fi

# ----------------------------------------------------------------- migrations
# Idempotent; run as charon so the created .db/-wal/-shm files are owned by the
# same uid as the server process.
log "applying database migrations → $DATABASE_URL"
run_as_charon node ./scripts/migrate.mjs

log "starting server on ${HOST:-0.0.0.0}:${PORT:-10556}"
exec_as_charon "$@"
