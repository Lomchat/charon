#!/usr/bin/env bash
# Build charon-agent.pyz — REPRODUCIBLE zipapp (zero external dependency).
# Usage :  bash agent/build.sh         → writes agent/dist/charon-agent.pyz
#          bash agent/build.sh OUT.pyz → writes to OUT.pyz
#
# Reproducibility matters beyond CI hygiene: the pyz sha (vps.agentPyzSha vs
# getBuiltPyzSha) DRIVES the fleet-wide auto-update tick (CLAUDE.md §14.53).
# With the old `python3 -m zipapp` build, a no-op rebuild changed the sha
# (fresh cp mtimes end up in the ZIP entries) and triggered a pointless
# update wave across every VPS. This script writes the ZIP itself: entries
# sorted by path, fixed timestamp, fixed permissions, __pycache__ excluded —
# same source ⇒ byte-identical pyz.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$SCRIPT_DIR/charon_agent"
OUT="${1:-$SCRIPT_DIR/dist/charon-agent.pyz}"

if [ ! -d "$PKG_DIR" ]; then
  echo "package not found: $PKG_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Structure: we copy the package UNDER a staging dir, and we add a
# __main__.py at the TOP of the staging dir that loads the package. This way,
# zipapp produces a pyz whose root contains __main__.py (the entry) +
# charon_agent/ (the package). Relative imports work normally.
STAGE="$TMP/stage"
mkdir -p "$STAGE"
cp -r "$PKG_DIR" "$STAGE/"
# Stray bytecode would be both nondeterministic and dead weight.
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -name '*.py[co]' -delete 2>/dev/null || true

cat > "$STAGE/__main__.py" <<'PY'
import sys
from charon_agent.__main__ import main
sys.exit(main())
PY

# Deterministic zipapp: sorted entries, fixed date_time + permissions.
# (python3 -m zipapp embeds filesystem mtimes → non-reproducible.)
python3 - "$STAGE" "$OUT" <<'PY'
import io, os, sys, zipfile

stage, out = sys.argv[1], sys.argv[2]
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    paths = []
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        for f in sorted(files):
            paths.append(os.path.join(root, f))
    for p in sorted(paths):
        rel = os.path.relpath(p, stage)
        zi = zipfile.ZipInfo(rel.replace(os.sep, "/"), date_time=(2020, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        with open(p, "rb") as fh:
            z.writestr(zi, fh.read())
with open(out, "wb") as f:
    f.write(b"#!/usr/bin/env python3\n")
    f.write(buf.getvalue())
PY

chmod +x "$OUT"
SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "→ built $OUT ($SIZE bytes, deterministic)"
