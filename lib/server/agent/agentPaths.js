/**
 * Per-hub agent INSTANCE paths — the single source of truth for "where does
 * *this* hub's agent live on a VPS".
 *
 * ── Why this module exists (§14.70) ────────────────────────────────────────
 * Charon used to assume ONE hub per VPS: a single `~/.charon`, a single
 * `agent.sock`, a single `state.json`, a single `charon-agent.service`. Point
 * two hubs at the same VPS and they don't become two clients of one agent —
 * they drive the SAME daemon, and every single-tenant assumption turns into a
 * cross-hub hazard:
 *   - `server.py` unlinks a pre-existing socket WITHOUT probing for a live
 *     owner, so the second daemon to boot silently steals the first's socket;
 *   - a departing daemon unlinks whatever socket sits at that path — including
 *     one a newer daemon just bound;
 *   - `cleanup_orphans()` deletes every event log whose session is absent from
 *     *its* state.json, i.e. the other hub's durable replay history;
 *   - `shellSession.ts` kills agent-side shells with no DB row — the other
 *     hub's shells;
 *   - two hubs on different commits have different `builtPyzSha`, so each
 *     sees the fleet as outdated and `sdkWatch` rolls the pyz back and forth
 *     every 30 min, restarting the daemon and cutting turns each cycle.
 *
 * The fix is namespacing, not multi-tenancy: each hub gets its OWN daemon,
 * socket, state, event logs and shells under `~/.charon-<instance>/`, with its
 * own systemd unit. Agent-side this needs zero new code — `CHARON_AGENT_HOME`
 * (`__main__.py § _default_state_dir`) already relocates state.json, the
 * socket, `events/` and `shells/`. All of this module's job is to make the HUB
 * emit the right paths and pass that env var through.
 *
 * ── What stays SHARED between instances (deliberate) ───────────────────────
 *   - `~/.charon/venv`  — claude-agent-sdk + openai-codex. Shared on purpose:
 *     an SDK upgrade from EITHER hub benefits both, which is the whole point
 *     of co-tenancy. Note it lives inside the legacy instance's directory;
 *     that's the price of zero migration for existing fleets, and it is
 *     therefore owned by no instance — never delete `~/.charon` to "clean up"
 *     an instance.
 *   - `~/.claude`  — the per-VPS OAuth login and CLI transcripts. One
 *     `claude login` serves every hub.
 *   - `~/.codex`   — same for the Codex device-code credentials.
 *
 * ── Identity comes from the ENV, not the DB ────────────────────────────────
 * `CHARON_INSTANCE` in `.env`. Not a `claudeSettings` row, for three reasons:
 * it must be readable before the DB is open; `server.js` (plain CJS, outside
 * Next) needs the exact same value as the TS runtime; and `settings.ts` caches
 * in a `globalThis` Map that a raw SQL write does not invalidate. It also
 * means you cannot change your hub's identity from a web form by accident —
 * doing so would orphan every daemon that hub owns.
 *
 * ── The legacy instance is byte-identical ──────────────────────────────────
 * With `CHARON_INSTANCE` unset every string this module produces is EXACTLY
 * what Charon emitted before it existed (`~/.charon`, `charon-agent.service`,
 * no `Environment=` line). `tests/agentPaths.test.ts` pins that character for
 * character, so shipping this to an existing fleet is a provable no-op.
 *
 * Plain CommonJS (like `sshShared.js`) so the root `server.js` can `require()`
 * it without a build step; tsconfig `allowJs` lets the TS side import it.
 */
'use strict';

/**
 * Instance ids are interpolated into filesystem paths, systemd unit names AND
 * `pkill -f` regexes, so the charset is deliberately narrow: lowercase
 * alphanumerics, `-` and `_`, starting with an alphanumeric, ≤32 chars. Every
 * one of those is regex-inert and shell-inert, which is what lets the rest of
 * this module interpolate without quoting.
 */
const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Validate a raw instance id. Exported so `configCheck.ts` can fail loudly at
 * boot rather than letting a bad value reach a `pkill` pattern.
 * @param {string|undefined|null} raw
 * @returns {{ok: true, instance: string} | {ok: false, error: string}}
 */
function parseInstance(raw) {
  const v = (raw ?? '').trim();
  if (v === '') return { ok: true, instance: '' };
  if (!INSTANCE_RE.test(v)) {
    return {
      ok: false,
      error:
        `invalid CHARON_INSTANCE ${JSON.stringify(v)} — must match ${INSTANCE_RE} ` +
        `(lowercase alphanumerics, dash, underscore; ≤32 chars; leading alphanumeric)`,
    };
  }
  return { ok: true, instance: v };
}

const _parsed = parseInstance(process.env.CHARON_INSTANCE);
/**
 * This hub's instance id. `''` = the legacy/default instance (`~/.charon`).
 * An invalid value degrades to legacy here; `configCheck.ts` is what surfaces
 * the error — this module must never throw at import time (it is pulled in by
 * `server.js` before any logging exists).
 */
const INSTANCE = _parsed.ok ? _parsed.instance : '';

/** Directory NAME under $HOME, e.g. `.charon` or `.charon-eleven`. */
const AGENT_DIR_NAME = INSTANCE ? `.charon-${INSTANCE}` : '.charon';

/** systemd-user unit name, e.g. `charon-agent.service` / `charon-agent-eleven.service`. */
const UNIT_NAME = INSTANCE ? `charon-agent-${INSTANCE}.service` : 'charon-agent.service';

/**
 * The instance directory in each of the three syntaxes we have to emit.
 * Keep them together so a new call site cannot pick the wrong flavour:
 *   tilde  — inside a remote command run by a login shell (`~` expands)
 *   home   — inside a remote *script* where `$HOME` is more predictable than
 *            `~` (notably after a `>` redirect or inside quotes)
 *   systemd— unit files, where `%h` is the specifier for the user's home
 */
const AGENT_DIR_TILDE = `~/${AGENT_DIR_NAME}`;
const AGENT_DIR_HOME = `$HOME/${AGENT_DIR_NAME}`;
const AGENT_DIR_SYSTEMD = `%h/${AGENT_DIR_NAME}`;

/** Path of this hub's agent pyz on the VPS (tilde form). */
const REMOTE_AGENT_PATH = `${AGENT_DIR_TILDE}/charon-agent.pyz`;

/** This hub's agent log on the VPS. */
const AGENT_LOG_TILDE = `${AGENT_DIR_TILDE}/agent.log`;
const AGENT_LOG_HOME = `${AGENT_DIR_HOME}/agent.log`;
const AGENT_LOG_SYSTEMD = `${AGENT_DIR_SYSTEMD}/agent.log`;

/**
 * The SHARED venv — identical for every instance on a host, by design (see
 * the header). Never namespace these.
 */
const SHARED_VENV_HOME = '$HOME/.charon/venv';
const SHARED_VENV_PY_HOME = `${SHARED_VENV_HOME}/bin/python`;
const SHARED_VENV_PY_SYSTEMD = '%h/.charon/venv/bin/python';

/**
 * `pkill -f` / `pgrep -f` pattern matching ONLY this instance's daemon.
 *
 * TWO anchors, both load-bearing:
 *   - the leading `/<dir>/` scopes the match to this instance — without it a
 *     hub tears down a co-tenant hub's daemon (the original single-tenant
 *     pattern `charon-agent.pyz$` matches every instance on the host);
 *   - the trailing `$` spares the shell HOLDERS, whose cmdline continues past
 *     the pyz (`… charon-agent.pyz --shell-holder <id> …`). Holders are
 *     exactly the processes that must survive an agent restart (§14.44).
 *
 * `.` is escaped so the regex cannot match a literal-dot-alike; the instance
 * charset (INSTANCE_RE) contains no regex metacharacters, so nothing else
 * needs quoting. Safe to embed in single quotes in a shell command.
 */
const AGENT_PKILL_PATTERN = `/\\.${AGENT_DIR_NAME.slice(1)}/charon-agent\\.pyz$`;

/**
 * `env` prefix that points the agent at this instance's state dir, for use in
 * remote commands. Empty for the legacy instance so its command lines stay
 * byte-identical to what shipped before instances existed.
 *
 * This is what makes `--connect` find the right socket: the agent derives the
 * socket path from the state dir (`__main__.py § _default_socket`), so without
 * it a namespaced hub would proxy to the DEFAULT instance's socket — i.e.
 * straight back into the co-tenancy bug this module exists to prevent.
 *
 * @param {'tilde'|'home'} [flavour]
 */
function agentHomeEnvPrefix(flavour = 'home') {
  if (!INSTANCE) return '';
  const dir = flavour === 'tilde' ? AGENT_DIR_TILDE : AGENT_DIR_HOME;
  return `env CHARON_AGENT_HOME=${dir} `;
}

/**
 * The `Environment=` line for the systemd unit, or '' for the legacy
 * instance (keeping its unit byte-identical to the pre-instance one, so
 * redeploying to an existing fleet rewrites the same bytes).
 */
function systemdEnvironmentLine() {
  return INSTANCE ? `Environment=CHARON_AGENT_HOME=${AGENT_DIR_SYSTEMD}\n` : '';
}

/** Human label for logs/UI, e.g. `default` or `eleven`. */
const INSTANCE_LABEL = INSTANCE || 'default';

module.exports = {
  INSTANCE,
  INSTANCE_LABEL,
  INSTANCE_RE,
  parseInstance,
  AGENT_DIR_NAME,
  AGENT_DIR_TILDE,
  AGENT_DIR_HOME,
  AGENT_DIR_SYSTEMD,
  UNIT_NAME,
  REMOTE_AGENT_PATH,
  AGENT_LOG_TILDE,
  AGENT_LOG_HOME,
  AGENT_LOG_SYSTEMD,
  SHARED_VENV_HOME,
  SHARED_VENV_PY_HOME,
  SHARED_VENV_PY_SYSTEMD,
  AGENT_PKILL_PATTERN,
  agentHomeEnvPrefix,
  systemdEnvironmentLine,
};
