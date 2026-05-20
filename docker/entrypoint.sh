#!/usr/bin/env sh
# Runs once before each container start.
# - Applies Drizzle migrations against the SQLite DB.
# - Ensures the data directory exists.
# - Hands off to `next start` (the Dockerfile CMD).
set -e

: "${DATABASE_URL:=./data/charon.db}"
DATA_DIR="$(dirname "$DATABASE_URL")"
mkdir -p "$DATA_DIR"

echo "[charon] applying database migrations → $DATABASE_URL"
node ./scripts/migrate.mjs

echo "[charon] starting server on ${HOST:-0.0.0.0}:${PORT:-10556}"
exec "$@"
