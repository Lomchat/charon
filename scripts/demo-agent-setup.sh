#!/usr/bin/env bash
# Set up an ISOLATED local charon-agent for the README screenshots, under a
# dedicated `charondemo` user so a shot can never touch real sessions/shells.
# 100% fictitious data. Idempotent. Run as root on the machine that runs the
# demo hub (the hub reaches this agent over SSH to charondemo@127.0.0.1).
#
#   sudo bash scripts/demo-agent-setup.sh
#
# Then: seed + run the demo hub + capture (see scripts/demo-shots.mjs header).
#
# This agent backs everything in the README that needs a LIVE VPS: the file
# explorer, the editor, the git tab / diff viewer / branch chip, and the
# terminal. The demo hub therefore points its "prod-eu-1" row at 127.0.0.1
# (see scripts/demo-seed.mjs) — every other VPS in the seed is fictitious and
# unreachable on purpose.
set -euo pipefail

USER_NAME=charondemo
HOME_DIR=/home/$USER_NAME
CHARON_DIR=$HOME_DIR/.charon
# The demo project. NOT under $HOME: its absolute path is on screen in the chat
# header, the tab bar and the terminal, and /home/charondemo/... would put the
# demo scaffolding in every screenshot.
APP=/srv/checkout-service
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYZ="$REPO_DIR/agent/dist/charon-agent.pyz"
# The public key the demo hub authenticates with (its ssh.private_key_path +
# ".pub"; falls back to root's default id_rsa).
PUBKEY=${DEMO_PUBKEY:-/root/.ssh/id_rsa.pub}
# Newest python >= 3.10 (the agent uses 3.10+ syntax).
PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || true)
# A venv with both SDKs, exactly like a bootstrapped VPS: the daemon runs from
# it so `hello` advertises sdk_version + codex_available, i.e. the sidebar shows
# a healthy dual-backend box instead of "claude/codex unavailable" chips.
# Non-fatal: without it the agent still serves files, git and shells.
VENV="$CHARON_DIR/venv"

[ -f "$PYZ" ] || { echo "build the pyz first: bash agent/build.sh"; exit 1; }
[ -n "$PY" ] || { echo "need python >= 3.10 on PATH"; exit 1; }
[ -f "$PUBKEY" ] || { echo "no ssh public key at $PUBKEY (set DEMO_PUBKEY)"; exit 1; }

id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"

# Authorize the hub's key + deploy the agent. The pyz is redeployed on every
# run: the file explorer needs >= 0.25.0, saving >= 0.26.0, create/rename/
# delete >= 0.27.0, git >= 0.24.0 — a stale demo agent silently degrades the
# shots to "update the agent" placeholders.
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh" "$CHARON_DIR"
install -m 600 -o "$USER_NAME" -g "$USER_NAME" "$PUBKEY" "$HOME_DIR/.ssh/authorized_keys"
install -m 700 -o "$USER_NAME" -g "$USER_NAME" "$PYZ" "$CHARON_DIR/charon-agent.pyz"

# ── A fictitious project: a small Fastify/TypeScript payments service ────────
# Deliberately shaped for the shots: a nested src/ tree (lazy expansion), a
# committed history with a remote (branch chip + forge link), and a dirty
# working tree whose changes MATCH the seeded conversation (the auth refactor
# in scripts/demo-seed.mjs) — the tree decorations, the git tab, the diff
# viewer and the chat all tell the same story.
rm -rf "$APP"
install -d "$APP" "$APP/src" "$APP/src/middleware" "$APP/src/lib" "$APP/src/routes" \
           "$APP/tests" "$APP/docs" "$APP/public"

cat > "$APP/package.json" <<'JSON'
{
  "name": "checkout-service",
  "version": "2.4.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "ioredis": "^5.4.1",
    "pg": "^8.12.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.16.2",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
JSON

cat > "$APP/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
JSON

cat > "$APP/README.md" <<'MD'
# checkout-service

Payments + checkout API for the storefront. Fastify, Postgres, Redis-backed
sessions.

    npm install
    npm run dev        # http://localhost:8080

See `docs/runbook.md` for the on-call runbook and `docs/` for the rest.
MD

printf 'node_modules\ndist\n.env\ncoverage\n*.tsbuildinfo\n' > "$APP/.gitignore"
printf 'DATABASE_URL=postgres://localhost:5432/checkout\nREDIS_URL=redis://localhost:6379\nSESSION_TTL=86400\nSTRIPE_KEY=\n' > "$APP/.env.example"

cat > "$APP/Dockerfile" <<'DOCKER'
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]
DOCKER

cat > "$APP/docs/runbook.md" <<'MD'
# Runbook

## Checkout 5xx spike
1. Check the Postgres connection pool (`pg_stat_activity`).
2. Redis evictions drop sessions -> every request 401s.
3. Roll back with `deploy rollback checkout-service`.
MD

cat > "$APP/public/logo.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect width="96" height="96" rx="20" fill="#1f2937"/>
  <path d="M24 60 L44 34 L58 52 L72 36" fill="none" stroke="#7c9cff" stroke-width="6"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="72" cy="36" r="6" fill="#9be29b"/>
</svg>
SVG

cat > "$APP/src/config.ts" <<'TS'
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SESSION_TTL: z.coerce.number().default(86_400),
});

export const config = {
  port: Number(process.env.PORT ?? 8080),
  env: Env.parse(process.env),
};
TS

cat > "$APP/src/server.ts" <<'TS'
import Fastify from "fastify";
import { auth } from "./middleware/auth.js";
import { logger } from "./lib/logger.js";

export const app = Fastify({ logger: true });

app.addHook("onRequest", auth);

app.setErrorHandler((err, _req, reply) => {
  logger.error({ err }, "unhandled");
  reply.status(err.statusCode ?? 500).send({ error: "internal_error" });
});
TS

cat > "$APP/src/index.ts" <<'TS'
import { app } from "./server.js";
import { config } from "./config.js";
import "./routes/checkout.js";
import "./routes/cart.js";
import "./routes/webhooks.js";
import "./routes/health.js";

await app.listen({ port: config.port, host: "0.0.0.0" });
TS

cat > "$APP/src/middleware/auth.ts" <<'TS'
import { getSessionSync } from "../lib/sessionStore.js";

/** Rejects anything without a live session cookie. */
export function auth(req, reply, done) {
  const sid = req.cookies.sid;
  const session = getSessionSync(sid);
  if (!session) return reply.status(401).send({ error: "unauthorized" });
  req.user = session.user;
  done();
}
TS

cat > "$APP/src/lib/sessionStore.ts" <<'TS'
import Redis from "ioredis";
import { config } from "../config.js";

const redis = new Redis(config.env.REDIS_URL);

export async function getSession(id: string) {
  if (!id) return null;
  const raw = await redis.get(`sess:${id}`);
  return raw ? JSON.parse(raw) : null;
}

/** @deprecated in-memory fallback, kept until every caller is async. */
export function getSessionSync(id: string) {
  return memory.get(id) ?? null;
}

const memory = new Map<string, { user: { id: string } }>();
TS

cat > "$APP/src/lib/db.ts" <<'TS'
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.env.DATABASE_URL, max: 10 });

export async function one<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await pool.query(sql, params);
  return (rows[0] as T) ?? null;
}
TS

cat > "$APP/src/lib/logger.ts" <<'TS'
export const logger = {
  info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ msg, ...(obj as object) })),
  error: (obj: unknown, msg?: string) => console.error(JSON.stringify({ msg, ...(obj as object) })),
};
TS

cat > "$APP/src/routes/checkout.ts" <<'TS'
import { app } from "../server.js";
import { one } from "../lib/db.js";

app.post("/checkout", async (req, reply) => {
  const cart = await one(
    "SELECT * FROM carts WHERE id = $1 AND user_id = $2",
    [req.body.cartId, req.user.id],
  );
  if (!cart) return reply.status(404).send({ error: "not_found" });
  return { ok: true, total: cart.total };
});
TS

cat > "$APP/src/routes/cart.ts" <<'TS'
import { app } from "../server.js";
import { one } from "../lib/db.js";

app.get("/cart/:id", async (req) =>
  one("SELECT * FROM carts WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]));
TS

cat > "$APP/src/routes/webhooks.ts" <<'TS'
import { app } from "../server.js";

app.post("/webhooks/stripe", { config: { rawBody: true } }, async (req) => {
  // signature verification happens in the gateway
  return { received: true, type: req.body.type };
});
TS

printf 'import { app } from "../server.js";\n\napp.get("/healthz", async () => ({ ok: true }));\n' > "$APP/src/routes/health.ts"

cat > "$APP/tests/auth.test.ts" <<'TS'
import { describe, it, expect } from "vitest";
import { auth } from "../src/middleware/auth.js";

describe("auth middleware", () => {
  it("401s without a session cookie", () => {
    const reply = { status: (c: number) => ({ send: () => c }) };
    expect(auth({ cookies: {} } as never, reply as never, () => {})).toBe(401);
  });
});
TS

printf 'import { describe, it, expect } from "vitest";\n\ndescribe("checkout", () => {\n  it("scopes the cart to the caller", () => expect(true).toBe(true));\n});\n' > "$APP/tests/checkout.test.ts"

cat > "$APP/deploy.log" <<'LOG'
[deploy] build #481 started — commit 7c1a9e2 (main)
[deploy] tsc: 0 errors · 124 files · 3.1s
[deploy] vitest: 214 passed · 0 failed · 6.8s
[deploy] uploaded 18 assets to edge (cdn-eu-1)
[deploy] ✓ live in 12.4s — https://checkout.example.com
LOG

chown -R "$USER_NAME:$USER_NAME" "$APP"

# History + a remote (drives the branch chip and the "open on the forge" link),
# then the dirty working tree the shots show.
sudo -u "$USER_NAME" bash -lc "
  set -e
  cd '$APP'
  git init -q -b main
  git config user.email dev@example.com
  git config user.name 'Demo Dev'
  git remote add origin git@github.com:acme/checkout-service.git
  git add -A && git commit -qm 'checkout-service: initial import'
  git commit -q --allow-empty -m 'checkout: scope the cart query to the caller'
  git commit -q --allow-empty -m 'ci: add vitest to the deploy gate'
  git commit -q --allow-empty -m 'sessions: move the store behind an interface'

  # A tracking ref two commits back → the branch chip shows '↑2 to push'
  # without ever talking to a real remote.
  git update-ref refs/remotes/origin/main HEAD~2
  git branch -q -u origin/main main

  # 1) modified — the async session-store swap the seeded chat is doing
  cat > src/middleware/auth.ts <<'EOF'
import { getSession } from \"../lib/sessionStore.js\";

/** Rejects anything without a live session cookie. */
export async function auth(req, reply) {
  const sid = req.cookies.sid;
  const session = await getSession(sid);
  if (!session) return reply.status(401).send({ error: \"unauthorized\" });
  req.user = session.user;
}
EOF

  # 2) modified — the limiter wired in front of /login
  cat > src/server.ts <<'EOF'
import Fastify from \"fastify\";
import { auth } from \"./middleware/auth.js\";
import { rateLimit } from \"./middleware/rateLimit.js\";
import { logger } from \"./lib/logger.js\";

export const app = Fastify({ logger: true });

app.addHook(\"onRequest\", auth);
app.addHook(\"onRequest\", rateLimit({ window: 900, max: 5, only: \"/login\" }));

app.setErrorHandler((err, _req, reply) => {
  logger.error({ err }, \"unhandled\");
  reply.status(err.statusCode ?? 500).send({ error: \"internal_error\" });
});
EOF

  # 3) untracked — the new sliding-window limiter
  cat > src/middleware/rateLimit.ts <<'EOF'
import Redis from \"ioredis\";
import { config } from \"../config.js\";

const redis = new Redis(config.env.REDIS_URL);

/** Sliding-window limiter: \`max\` requests per \`window\` seconds, keyed by IP. */
export function rateLimit(opts: { window: number; max: number; only?: string }) {
  return async (req, reply) => {
    if (opts.only && req.url !== opts.only) return;
    const key = \"rl:\" + (opts.only ?? \"*\") + \":\" + req.ip;
    const now = Date.now();
    await redis.zremrangebyscore(key, 0, now - opts.window * 1000);
    const hits = await redis.zcard(key);
    if (hits >= opts.max) return reply.status(429).send({ error: \"rate_limited\" });
    await redis.zadd(key, now, String(now));
    await redis.expire(key, opts.window);
  };
}
EOF

  # 4) modified — the test that follows the middleware
  printf '\n  it(\"awaits the async store\", async () => {\n    // TODO: fake redis\n  });\n' >> tests/auth.test.ts
"

if [ ! -x "$VENV/bin/python" ]; then
  sudo -u "$USER_NAME" "$PY" -m venv "$VENV" \
    && sudo -u "$USER_NAME" "$VENV/bin/pip" -q install --upgrade pip \
    && sudo -u "$USER_NAME" "$VENV/bin/pip" -q install claude-agent-sdk openai-codex \
    || echo "warn: demo venv incomplete — the box will show its backends as unavailable"
fi
[ -x "$VENV/bin/python" ] && PY="$VENV/bin/python"

# (Re)start the daemon, detached under the demo user.
pkill -u "$USER_NAME" 2>/dev/null || true; sleep 1
rm -f "$CHARON_DIR"/shells/* "$CHARON_DIR"/state.json 2>/dev/null || true
sudo -u "$USER_NAME" env HOME="$HOME_DIR" setsid "$PY" "$CHARON_DIR/charon-agent.pyz" \
  >"$CHARON_DIR/boot.log" 2>&1 </dev/null &
sleep 3
if [ -S "$CHARON_DIR/agent.sock" ]; then
  echo "sandbox agent up ($PY) — hub reaches it at $USER_NAME@127.0.0.1, project $APP"
else
  echo "sandbox agent FAILED to start; see $CHARON_DIR/boot.log"; exit 1
fi
