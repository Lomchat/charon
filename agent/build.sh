#!/usr/bin/env bash
# Build charon-agent.pyz via stdlib zipapp (zero external dependency).
# Usage :  bash agent/build.sh         → writes agent/dist/charon-agent.pyz
#          bash agent/build.sh OUT.pyz → writes to OUT.pyz
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

cat > "$STAGE/__main__.py" <<'PY'
import sys
from charon_agent.__main__ import main
sys.exit(main())
PY

python3 -m zipapp "$STAGE" \
  -o "$OUT" \
  -p "/usr/bin/env python3" \
  --compress

chmod +x "$OUT"
SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "→ built $OUT ($SIZE bytes)"
