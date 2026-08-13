#!/bin/bash

cd "$(dirname "$0")"

# Point the addon at the libchdb.so that ships beside it, instead of whatever the
# linker recorded.
#
# Which name the linker records comes from the engine's install_name, and that is
# not stable: chdb-core shipped `libchdb.so` through v26.5.x and `@rpath/libchdb.so`
# from v26.7.0. `install_name_tool -change` silently succeeds when the old name
# matches nothing, so a script that knew only one spelling left the addon pointing
# at `@rpath/libchdb.so` with no LC_RPATH to resolve it — and the failure surfaced
# far away, as ERR_DLOPEN_FAILED when the loader tried to require the addon.
#
# Hence: rewrite every spelling we have seen, then verify. A dependency this script
# cannot resolve is a build failure, not something to discover at runtime.
if [[ $(uname -s) == "Darwin" ]]; then
    ADDON=build/Release/chdb_node.node
    TARGET=@loader_path/../../libchdb.so

    for old in libchdb.so @rpath/libchdb.so; do
        install_name_tool -change "$old" "$TARGET" "$ADDON" 2>/dev/null || true
    done

    otool -L "$ADDON"

    if otool -L "$ADDON" | grep 'libchdb\.so' | grep -qv "$TARGET"; then
        echo "fix_loader_path.sh: the libchdb dependency in $ADDON is not $TARGET." >&2
        echo "The engine's install_name is probably a spelling this script does not" >&2
        echo "know yet; add it to the loop above. dlopen would fail at runtime." >&2
        otool -L "$ADDON" | grep 'libchdb\.so' >&2
        exit 1
    fi
fi
