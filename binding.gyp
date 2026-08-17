{
  "targets": [
    {
      "target_name": "chdb_node",
      "sources": [ "lib/chdb_node.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "."
      ],
      "libraries": [ "<(module_root_dir)/libchdb.so" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='linux'", {
          # Carry the C++ runtime inside the addon. Linked dynamically it demands
          # whatever libstdc++ the build machine had — GCC 13 emits
          # GLIBCXX_3.4.32, absent on Debian bookworm (the base of the node:22 /
          # node:20 / node:lts images), Ubuntu 22.04 and Amazon Linux 2023, where
          # the install succeeds and require() then dies with ERR_DLOPEN_FAILED.
          # libchdb.so links no libstdc++ at all, so the addon is the only thing
          # that drags one in.
          #
          # Half the story: a static libstdc++ taken from a modern host brings
          # newer libc symbols along with it, so the release build also links in
          # an old-glibc container (scripts/build-addon-portable.sh), and
          # scripts/assert-runtime-baseline.sh checks what comes out.
          "ldflags": [ "-static-libstdc++", "-static-libgcc" ]
        }],
        ["OS=='mac'", {
          # The same failure mode as the Linux branch above, by a different
          # mechanism: without this, the deployment target is whatever the build
          # machine's SDK defaults to, and it becomes a hard floor — a binary
          # built on a macos-15 runner refuses to load on anything older. The
          # published subpackages happen to sit at 11.0 today, which is right,
          # but only because no runner has moved yet.
          #
          # 11.0 rather than lower: libchdb.so is itself built for 11.0 on arm64,
          # and Node's own macOS binaries require 11.0 from Node 20 on, so
          # nothing that can run this can be older. scripts/assert-runtime-baseline.sh
          # checks the result.
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          }
        }]
      ]
    }
  ]
}