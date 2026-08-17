#!/bin/bash
# Assert a packaged native addon does not demand a newer C/C++ runtime than the
# oldest platform chdb claims to run on.
#
# The failure it catches: an addon linked on a modern build machine records the
# symbol versions that machine's GCC and glibc emitted, and the dynamic loader
# refuses the binary anywhere older. It installs fine — the breakage lands at
# require() time, as ERR_DLOPEN_FAILED, on a machine no CI job ever visits:
#
#   libstdc++.so.6: version `GLIBCXX_3.4.32' not found   (GCC 13, dynamic libstdc++)
#   libc.so.6: version `GLIBC_2.38' not found            (static libstdc++, glibc 2.39 host)
#
# Debian bookworm — the base of the node:22 / node:20 / node:lts images — offers
# GLIBCXX_3.4.30 and GLIBC_2.36, so both of those kill it. Building and testing
# on ubuntu-24.04 alone cannot see this: every leg has the same modern runtime.
#
# The two rules:
#
#   1. No GLIBCXX_/CXXABI_ requirement at all. libchdb.so links no libstdc++
#      whatsoever, so the addon is the only thing that can drag one in; carrying
#      the C++ runtime statically (binding.gyp) removes the whole failure class
#      rather than moving the version floor around.
#
#   2. No glibc symbol newer than 2.28. That is the floor Node's own official
#      Linux builds require, so an addon that stays at or under it loads
#      anywhere Node itself runs — RHEL/Alma/Rocky 8 (2.28), Ubuntu 20.04
#      (2.31), Amazon Linux 2023 (2.34), Ubuntu 22.04 (2.35), Debian bookworm
#      (2.36). libchdb.so needs nothing above 2.17, so the engine never forces
#      the number up; only the addon's build host can. Reaching it means linking
#      the addon in an old-glibc container (scripts/build-addon-portable.sh) —
#      a build on the ubuntu-24.04 runner lands at 2.38 and fails here.
#
# macOS has no ELF symbol versioning; the check is skipped there.
#
# Usage: assert-runtime-baseline.sh <path-to-chdb_node.node>
set -euo pipefail

MAX_GLIBC=2.28

NODE_FILE="${1:?usage: assert-runtime-baseline.sh <chdb_node.node>}"
[ -f "$NODE_FILE" ] || { echo "assert-runtime-baseline: no such file: $NODE_FILE" >&2; exit 1; }

fail() { echo "assert-runtime-baseline: FAIL — $1" >&2; exit 1; }

if [ "$(uname -s)" != "Linux" ]; then
  echo "assert-runtime-baseline: skipped on $(uname -s) (ELF symbol versioning is Linux-only)"
  exit 0
fi

command -v readelf >/dev/null || fail "readelf not found (install binutils)"

# .gnu.version_r is the authoritative list of versioned symbols the loader has to
# satisfy — one entry per version node actually referenced.
needs=$(readelf --version-info --wide "$NODE_FILE" | sed -nE 's/.*Name: ([A-Za-z_]+_[0-9][0-9.]*).*/\1/p' | sort -u)

cxx=$(printf '%s\n' "$needs" | grep -E '^(GLIBCXX|CXXABI)_' || true)
if [ -n "$cxx" ]; then
  fail $'the addon links the C++ runtime dynamically; build it with -static-libstdc++.\nversions demanded:\n'"$cxx"
fi

glibc=$(printf '%s\n' "$needs" | grep -E '^GLIBC_' | sed 's/^GLIBC_//' | sort -V || true)
worst=$(printf '%s\n' "$glibc" | tail -1)
if [ -n "$worst" ] && [ "$(printf '%s\n%s\n' "$MAX_GLIBC" "$worst" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
  fail $'needs glibc '"$worst"' but the baseline is '"$MAX_GLIBC"$'.\nBuilt on a host whose glibc is too new — link it in an old-glibc container\n(scripts/build-addon-portable.sh). Versions demanded:\n'"$(printf 'GLIBC_%s\n' $glibc)"
fi

echo "assert-runtime-baseline: OK — $(basename "$NODE_FILE") needs no libstdc++ and nothing above GLIBC_${worst:-none} (baseline $MAX_GLIBC)"
