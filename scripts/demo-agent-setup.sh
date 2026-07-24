#!/usr/bin/env bash
# Set up an ISOLATED local charon-agent for the README shell screenshot, under a
# dedicated `charondemo` user so the shot can never touch real sessions/shells.
# 100% fictitious data. Idempotent. Run as root on the machine that runs the
# demo hub (the hub reaches this agent over SSH to charondemo@127.0.0.1).
#
#   sudo bash scripts/demo-agent-setup.sh
#
# Then: seed + run the demo hub + capture (see scripts/demo-shots.mjs header).
set -euo pipefail

USER_NAME=charondemo
HOME_DIR=/home/$USER_NAME
CHARON_DIR=$HOME_DIR/.charon
APP=$HOME_DIR/app
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYZ="$REPO_DIR/agent/dist/charon-agent.pyz"
# The public key the demo hub authenticates with (its ssh.private_key_path +
# ".pub"; falls back to root's default id_rsa).
PUBKEY=${DEMO_PUBKEY:-/root/.ssh/id_rsa.pub}
# Newest python >= 3.10 (the agent uses 3.10+ syntax).
PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || true)

[ -f "$PYZ" ] || { echo "build the pyz first: bash agent/build.sh"; exit 1; }
[ -n "$PY" ] || { echo "need python >= 3.10 on PATH"; exit 1; }
[ -f "$PUBKEY" ] || { echo "no ssh public key at $PUBKEY (set DEMO_PUBKEY)"; exit 1; }

id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"

# Authorize the hub's key + deploy the agent.
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh" "$CHARON_DIR"
install -m 600 -o "$USER_NAME" -g "$USER_NAME" "$PUBKEY" "$HOME_DIR/.ssh/authorized_keys"
install -m 700 -o "$USER_NAME" -g "$USER_NAME" "$PYZ" "$CHARON_DIR/charon-agent.pyz"

# A small fictitious project so the terminal commands (ls / git status / tail
# deploy.log) produce clean, realistic output.
rm -rf "$APP"; install -d -o "$USER_NAME" -g "$USER_NAME" "$APP" "$APP/src" "$APP/src/routes"
cat > "$APP/package.json" <<'JSON'
{
  "name": "checkout-service",
  "version": "2.4.1",
  "private": true,
  "scripts": { "dev": "tsx watch src/server.ts", "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "fastify": "^4.28.0", "pg": "^8.12.0", "zod": "^3.23.8" }
}
JSON
printf '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "strict": true, "outDir": "dist" } }\n' > "$APP/tsconfig.json"
printf '# checkout-service\n\nPayments + checkout API. See docs/ for the runbook.\n' > "$APP/README.md"
printf 'node_modules\ndist\n.env\n' > "$APP/.gitignore"
printf 'export const config = { port: 8080, db: process.env.DATABASE_URL };\n' > "$APP/src/config.ts"
printf 'import Fastify from "fastify";\nexport const app = Fastify({ logger: true });\n' > "$APP/src/server.ts"
printf 'import { app } from "./server";\nimport "./routes/checkout";\napp.listen({ port: 8080 });\n' > "$APP/src/index.ts"
printf 'app.post("/checkout", async (req) => { /* ... */ });\n' > "$APP/src/routes/checkout.ts"
cat > "$APP/deploy.log" <<'LOG'
[deploy] build #481 started — commit 7c1a9e2 (main)
[deploy] tsc: 0 errors · 124 files · 3.1s
[deploy] vitest: 214 passed · 0 failed · 6.8s
[deploy] uploaded 18 assets to edge (cdn-eu-1)
[deploy] ✓ live in 12.4s — https://checkout.example.com
LOG
chown -R "$USER_NAME:$USER_NAME" "$APP"
sudo -u "$USER_NAME" bash -lc "
  cd '$APP'
  git init -q; git config user.email demo@example.com; git config user.name 'Demo Dev'
  git add -A && git commit -qm 'checkout-service: initial import'
  git commit -q --allow-empty -m 'checkout: parameterise cart query (authz fix)'
  git commit -q --allow-empty -m 'ci: add vitest to the deploy gate'
  printf 'export const RATE_LIMIT = { window: 900, max: 5 };\n' > src/rateLimit.ts
  printf '\n// TODO: wire the sliding-window limiter\n' >> src/server.ts
"

# (Re)start the daemon, detached under the demo user.
pkill -u "$USER_NAME" 2>/dev/null || true; sleep 1
rm -f "$CHARON_DIR"/shells/* "$CHARON_DIR"/state.json 2>/dev/null || true
sudo -u "$USER_NAME" env HOME="$HOME_DIR" setsid "$PY" "$CHARON_DIR/charon-agent.pyz" \
  >"$CHARON_DIR/boot.log" 2>&1 </dev/null &
sleep 3
if [ -S "$CHARON_DIR/agent.sock" ]; then
  echo "sandbox agent up ($PY) — hub reaches it at $USER_NAME@127.0.0.1"
else
  echo "sandbox agent FAILED to start; see $CHARON_DIR/boot.log"; exit 1
fi
