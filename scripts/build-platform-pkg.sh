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
  # node-gyp links the addon against the absolute build path
  # (<module_root_dir>/libchdb.so) and libchdb.so carries no DT_SONAME, so ld
  # bakes that absolute path as the DT_NEEDED. `--set-rpath '$ORIGIN'` alone
  # does NOT fix it: the dynamic loader opens an absolute NEEDED verbatim and
  # ignores RUNPATH, so the addon only loads on a machine that happens to have
  # the build path (chdb-io/chdb-node#50). Rewrite the path-bearing NEEDED back
  # to a bare soname FIRST, then point RUNPATH at the addon's own dir so it
  # resolves the sibling libchdb.so shipped in the subpackage.
  abs_needed=$(patchelf --print-needed "$PKG/chdb_node.node" | grep -E '/libchdb\.so$' || true)
  if [ -n "$abs_needed" ]; then
    patchelf --replace-needed "$abs_needed" libchdb.so "$PKG/chdb_node.node"
  fi
  patchelf --set-rpath '$ORIGIN' "$PKG/chdb_node.node"
fi

# Guard against shipping a binary that only loads on the build machine: assert
# the packaged addon has no build-absolute library references. Environment-
# independent (it inspects the binary, not its runtime), so it catches the bug
# even on the build runner where a stale absolute path still resolves.
bash scripts/assert-relocatable.sh "$PKG/chdb_node.node"

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
