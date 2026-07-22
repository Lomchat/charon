# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1 : install deps + build the Next app.
#
# Uses Debian-slim because `better-sqlite3` ships native modules that require
# build-essential + python at install time (no precompiled prebuilds for every
# Node/architecture). The image stays under ~250 MB after the runner stage
# below trims it down.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 native build deps. Removed after npm ci via apt purge in the
# runner stage (we don't rebuild from source there).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential \
       python3 \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the source tree (respects .dockerignore).
COPY . .

# Build with dummy env so any module that reads env at import time doesn't
# crash. These values are never used at runtime — the real ones come from
# the runtime env / .env file.
ENV NODE_ENV=production \
    SESSION_SECRET=build-dummy \
    MASTER_PASSWORD=build-dummy \
    MASTER_SALT=build-dummy \
    SYNC_TOKEN=build-dummy

RUN npm run build

# Trim what the runner stage will copy:
# - .next/cache is webpack build cache, useless at runtime and huge.
# - devDependencies are only needed for the build above.
RUN rm -rf .next/cache \
  && npm prune --omit=dev --no-audit --no-fund


# -----------------------------------------------------------------------------
# Stage 2 : minimal runtime image.
#
# Includes: Node 20, openssh-client (Charon spawns ssh), the prebuilt .next,
# the agent zipapp (charon-agent.pyz), and node_modules pruned to production.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10556

# openssh-client : Charon shells out to `ssh` for every VPS connection.
# ca-certificates : TLS for web-push / Telegram outbound calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openssh-client \
       ca-certificates \
       tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 charon \
  && useradd  --system --uid 1001 --gid charon --create-home --shell /sbin/nologin charon \
  && mkdir -p /app/data \
  && chown -R charon:charon /app

COPY --from=builder --chown=charon:charon /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=charon:charon /app/node_modules ./node_modules
COPY --from=builder --chown=charon:charon /app/.next ./.next
COPY --from=builder --chown=charon:charon /app/public ./public
COPY --from=builder --chown=charon:charon /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=charon:charon /app/drizzle ./drizzle
COPY --from=builder --chown=charon:charon /app/scripts ./scripts
COPY --from=builder --chown=charon:charon /app/lib ./lib
COPY --from=builder --chown=charon:charon /app/agent ./agent
# server.js is the REAL entrypoint: custom Next server + the WebSocket
# upgrade for /api/shells/[id]/ws. `next start` alone would silently ship
# an app with broken shells.
COPY --from=builder --chown=charon:charon /app/server.js ./server.js

# Entrypoint runs migrations before starting the server, idempotent.
COPY --chown=charon:charon docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER charon
VOLUME ["/app/data"]
EXPOSE 10556

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10556)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node server.js — NOT `next start`: server.js hosts the WS shell bridge.
# HOST/PORT come from the env (defaults above).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
