#!/bin/bash
# Build the per-platform native subpackage @chdb/lib-<platform> from the already
# built addon (build/Release/chdb_node.node) + libchdb. CI runs this on each of
# the 4 target runners; the result is published as a versioned npm subpackage
# that the main package pulls in via optionalDependencies (loader §4 / Item 1).
#
# Version: pass CHDB_LIB_VERSION (the chdb-core release line, e.g. 26.5.0 — the
# publish workflow derives it from update_libchdb.sh); defaults to 0.0.0-dev.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${CHDB_LIB_VERSION:-0.0.0-dev}"

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)   PLAT=darwin-arm64;     OS=darwin; CPU=arm64; LIBC="" ;;
  Darwin/x86_64)  PLAT=darwin-x64;       OS=darwin; CPU=x64;   LIBC="" ;;
  Linux/x86_64)   PLAT=linux-x64-gnu;    OS=linux;  CPU=x64;   LIBC=glibc ;;
  Linux/aarch64)  PLAT=linux-arm64-gnu;  OS=linux;  CPU=arm64; LIBC=glibc ;;
  *) echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

PKG="npm/@chdb/lib-${PLAT}"
echo "Building $PKG (version $VERSION)"
rm -rf "$PKG"
mkdir -p "$PKG"

cp build/Release/chdb_node.node "$PKG/"
cp libchdb.so "$PKG/"

# Fix the runtime library path so the addon finds libchdb.so sitting next to it
# in the subpackage (dev build referenced @loader_path/../../libchdb.so).
if [[ "$OS" == "darwin" ]]; then
  install_name_tool -change @loader_path/../../libchdb.so @loader_path/libchdb.so "$PKG/chdb_node.node"
else
  # $ORIGIN so the addon resolves libchdb.so from its own dir at runtime.
  patchelf --set-rpath '$ORIGIN' "$PKG/chdb_node.node"
fi

echo "module.exports = require('./chdb_node.node');" > "$PKG/index.js"

LIBC_FIELD=""
[[ -n "$LIBC" ]] && LIBC_FIELD=$',\n  "libc": ["'"$LIBC"'"]'

cat > "$PKG/package.json" <<EOF
{
  "name": "@chdb/lib-${PLAT}",
  "version": "${VERSION}",
  "description": "chdb native binding for ${PLAT}",
  "main": "index.js",
  "os": ["${OS}"],
  "cpu": ["${CPU}"]${LIBC_FIELD},
  "files": ["chdb_node.node", "libchdb.so", "index.js"],
  "license": "Apache-2.0"
}
EOF

echo "Wrote $PKG:"
ls -la "$PKG"
