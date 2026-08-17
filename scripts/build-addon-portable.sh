#!/bin/bash
# Re-link the Linux addon inside an old-glibc container so the published binary
# loads on distributions older than the build runner.
#
# Why this exists: the addon is compiled on ubuntu-24.04 (GCC 13, glibc 2.39) and
# the linker records that runtime's symbol versions in the binary. Users install
# it on Debian bookworm — the base of the node:22 / node:20 / node:lts images —
# and require() dies with `GLIBCXX_3.4.32 not found`. Linking the C++ runtime
# statically (binding.gyp) removes the libstdc++ dependency but not the problem:
# the static libstdc++ on a 2.39 host pulls in __isoc23_strtoul, so the binary
# then demands GLIBC_2.38 and bookworm (2.36) still refuses it. The glibc floor
# is a property of the machine that links, and nothing in the source can lower
# it — so link somewhere old.
#
# AlmaLinux 8 is glibc 2.28, which is also the floor Node's own official Linux
# builds require: the addon ends up loadable anywhere Node itself runs. Its
# gcc-toolset compilers target that glibc while still being new enough for the
# C++ the addon and node-addon-api use.
#
# Only the link step moves. node-gyp has already run on the host, so the
# generated Makefile, the downloaded node headers and node_modules are reused
# as-is; the container mounts them at their original absolute paths and runs
# make. That keeps node, npm and python out of the container entirely.
#
# Run after `npm run build`, before packaging. No-op on macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

BUILDER_IMAGE="${CHDB_BUILDER_IMAGE:-docker.io/library/almalinux:8}"
TOOLSET="${CHDB_GCC_TOOLSET:-gcc-toolset-13}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "build-addon-portable: skipped on $(uname -s) (Linux-only)"
  exit 0
fi

[ -f build/Release/chdb_node.node ] || {
  echo "build-addon-portable: build/Release/chdb_node.node is missing — run 'npm run build' first" >&2
  exit 1
}

RUNTIME=""
for c in docker podman; do command -v "$c" >/dev/null && { RUNTIME="$c"; break; }; done
[ -n "$RUNTIME" ] || { echo "build-addon-portable: neither docker nor podman is available" >&2; exit 1; }

# The generated Makefile points at the node headers by absolute path, and
# node-gyp puts them outside the repository by default. Read the path out of the
# Makefile rather than guessing where node-gyp cached them, and mount it at the
# same location so the recorded -I flags still resolve.
HDR=$(grep -ohE -- '-I[^ ]*/include/node' build/*.mk 2>/dev/null | sed -n '1s/^-I//p' || true)
[ -n "$HDR" ] || { echo "build-addon-portable: no node header include found in build/*.mk" >&2; exit 1; }
HDR_ROOT=$(cd "$HDR/../../.." && pwd)

MOUNTS=(-v "$PWD:$PWD")
case "$HDR_ROOT/" in
  "$PWD"/*) ;;                                   # already inside the repo mount
  *) MOUNTS+=(-v "$HDR_ROOT:$HDR_ROOT") ;;
esac

echo "build-addon-portable: re-linking in $BUILDER_IMAGE via $RUNTIME"
"$RUNTIME" run --rm "${MOUNTS[@]}" -w "$PWD" \
  -e "TOOLSET=$TOOLSET" -e "OWNER=$(id -u):$(id -g)" \
  "$BUILDER_IMAGE" bash -euo pipefail -c '
    dnf -y --setopt=retries=5 install "${TOOLSET}-gcc-c++" make >/dev/null
    export PATH="/opt/rh/${TOOLSET}/root/usr/bin:$PATH"
    # Printed whole rather than piped through head: under pipefail a reader that
    # closes after one line SIGPIPEs the writer and takes the script with it, and
    # no single quotes can appear here either — this whole command is one.
    g++ --version
    ldd --version
    # Force a real recompile: make would otherwise consider the object the host
    # produced up to date and only the link step would change hosts.
    rm -rf build/Release/obj.target build/Release/chdb_node.node
    make -C build BUILDTYPE=Release
    # Hand the artifacts back to the invoking user; a rootless runtime already
    # maps them there and rejects the call, which is not a build failure.
    chown -R "$OWNER" build 2>/dev/null || true
  '

bash scripts/assert-runtime-baseline.sh build/Release/chdb_node.node
