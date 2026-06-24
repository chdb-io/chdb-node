#!/bin/bash
# Assert a packaged native addon carries NO build-machine-absolute library
# reference — the environment-independent guard against "works on the build
# machine" packaging bugs.
#
# The failure it catches (chdb-io/chdb-node#50): a prebuilt chdb_node.node
# whose libchdb.so dependency is baked as the CI checkout path
# (/home/runner/work/chdb-node/chdb-node/libchdb.so) loads fine on the build
# runner — where that path still exists — but nowhere else, so every Linux
# user hits "cannot open shared object file". A `patchelf --set-rpath '$ORIGIN'`
# does NOT fix an absolute DT_NEEDED: the loader opens an absolute NEEDED
# verbatim, ignoring RUNPATH. This check fails the build when that (or any
# other absolute dylib reference) is present, regardless of whether the build
# machine happens to satisfy the stale path.
#
# Usage: assert-relocatable.sh <path-to-chdb_node.node>
set -euo pipefail

NODE_FILE="${1:?usage: assert-relocatable.sh <chdb_node.node>}"
[ -f "$NODE_FILE" ] || { echo "assert-relocatable: no such file: $NODE_FILE" >&2; exit 1; }

fail() { echo "assert-relocatable: FAIL — $1" >&2; exit 1; }

case "$(uname -s)" in
  Linux)
    command -v readelf >/dev/null || fail "readelf not found (install binutils)"
    dyn=$(readelf -d "$NODE_FILE")
    needed=$(printf '%s\n' "$dyn" | sed -nE 's/.*\(NEEDED\).*\[(.*)\]/\1/p')
    # Every NEEDED must be a bare soname (no slash); a slash means an absolute
    # or relative path was baked in at link time and won't relocate.
    if printf '%s\n' "$needed" | grep -q '/'; then
      fail $'path-bearing NEEDED entry (must be a bare soname resolved via RUNPATH):\n'"$needed"
    fi
    # libchdb.so must be referenced by its bare name so $ORIGIN finds the
    # sibling copy shipped in the subpackage.
    if ! printf '%s\n' "$needed" | grep -qx 'libchdb.so'; then
      fail $'expected a bare "libchdb.so" NEEDED entry; got:\n'"$needed"
    fi
    # RUNPATH (or legacy RPATH) must point at $ORIGIN — the addon's own dir.
    if ! printf '%s\n' "$dyn" | grep -E '\((RUNPATH|RPATH)\)' | grep -q '\$ORIGIN'; then
      rp=$(printf '%s\n' "$dyn" | grep -E '\((RUNPATH|RPATH)\)' || echo '(none)')
      fail $'RUNPATH/RPATH must contain $ORIGIN; got:\n'"$rp"
    fi
    ;;
  Darwin)
    command -v otool >/dev/null || fail "otool not found"
    # Collect every LC_LOAD_DYLIB target. None may be an absolute filesystem
    # path except the OS libraries under /usr/lib or /System; everything else
    # must be @loader_path/@rpath/@executable_path-relative.
    loads=$(otool -l "$NODE_FILE" | awk '/LC_LOAD_DYLIB/{f=1;next} f&&/^[[:space:]]*name /{print $2;f=0}')
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      case "$p" in
        @*|/usr/lib/*|/System/*) ;;                       # relocatable or OS lib — ok
        *) fail "non-relocatable dylib reference: $p" ;;
      esac
    done <<< "$loads"
    if ! printf '%s\n' "$loads" | grep -q '@loader_path/libchdb.so'; then
      fail $'expected "@loader_path/libchdb.so" load command; got:\n'"$loads"
    fi
    ;;
  *)
    fail "unsupported OS $(uname -s)"
    ;;
esac

echo "assert-relocatable: OK — $(basename "$NODE_FILE") has no build-machine-absolute library refs"
