#!/usr/bin/env bash
# Build charon-agent.pyz via stdlib zipapp (zéro dépendance externe).
# Usage :  bash agent/build.sh         → écrit agent/dist/charon-agent.pyz
#          bash agent/build.sh OUT.pyz → écrit dans OUT.pyz
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$SCRIPT_DIR/charon_agent"
OUT="${1:-$SCRIPT_DIR/dist/charon-agent.pyz}"

if [ ! -d "$PKG_DIR" ]; then
  echo "package introuvable: $PKG_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Structure : on copie le package SOUS un dir staging, et on ajoute un
# __main__.py au TOP du staging qui charge le package. Ainsi, zipapp produit
# un pyz dont la racine contient __main__.py (l'entrée) + charon_agent/
# (le package). Les imports relatifs marchent normalement.
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
