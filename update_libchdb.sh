#!/bin/bash

# This script will download the latest libchdb release from GitHub and extract
# the libchdb.so file to the current directory. This script is intended to be
# used by the build process to ensure that the latest version of libchdb is
# used.

# Change directory to the script's directory
cd "$(dirname "$0")"

# Fail fast so a bad download never silently leaves a stale/partial libchdb.
set -e

# Pre-release engine for the 3.1.0-rc.1 test line (carries the written-rows
# accessors the raw/streaming insert needs; absent in the v26.5.0 stable line).
LATEST_RELEASE=v26.5.1-rc.1

# Version published for the @chdb/lib-<platform> native subpackages on npm.
# DECOUPLED from LATEST_RELEASE on purpose: chdb-core has no 26.5.2 release, but
# the previously published subpackage versions (26.5.0, 26.5.1-rc.1) shipped a
# non-relocatable Linux binary (chdb-io/chdb-node#50). npm forbids republishing
# over an existing version, so the relocatability fix needs a NEW version — a
# formal packaging revision — while the bundled libchdb stays LATEST_RELEASE
# above (the only build carrying the #73/#15 C-ABI the binding requires). The
# publish + cleanroom workflows read CHDB_LIB_VERSION from here, and the main
# package's optionalDependencies pin this exact value.
LIBCHDB_NPM_VERSION=26.5.2

# Download the correct version based on the platform
case "$(uname -s)" in
    Linux)
        if [[ $(uname -m) == "aarch64" ]]; then
            PLATFORM="linux-aarch64-libchdb.tar.gz"
        else
            PLATFORM="linux-x86_64-libchdb.tar.gz"
        fi
        ;;
    Darwin)
        if [[ $(uname -m) == "arm64" ]]; then
            PLATFORM="macos-arm64-libchdb.tar.gz"
        else
            PLATFORM="macos-x86_64-libchdb.tar.gz"
        fi
        ;;
    *)
        echo "Unsupported platform"
        exit 1
        ;;
esac

DOWNLOAD_URL="https://github.com/chdb-io/chdb-core/releases/download/$LATEST_RELEASE/$PLATFORM"

echo "Downloading $PLATFORM from $DOWNLOAD_URL"

# Download with retries + fail on HTTP errors. The tarball is 100-156 MB and,
# fetched across many parallel CI jobs, a bare curl occasionally returns a
# truncated body -> tar then fails with a confusing "chdb.h: No such file" at
# build time. Retry transient failures and stop early on a hard HTTP error.
curl --fail --location --retry 5 --retry-delay 3 --retry-all-errors \
     --connect-timeout 30 -o libchdb.tar.gz "$DOWNLOAD_URL"

# Verify the archive is intact before extracting, so a truncated download is
# caught here with a clear message instead of downstream as a missing header.
if ! tar -tzf libchdb.tar.gz >/dev/null 2>&1; then
  echo "Downloaded libchdb.tar.gz is corrupt or truncated; aborting." >&2
  exit 1
fi

# Untar the file
tar -xzf libchdb.tar.gz

# Set execute permission for libchdb.so
chmod +x libchdb.so

# Clean up
rm -f libchdb.tar.gz
