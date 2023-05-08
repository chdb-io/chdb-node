{
  "targets": [
    {
      "target_name": "addon",
      "sources": [ "src/addon.cc" ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include\")",
        "include/"
      ],
      "libraries": [ "-L/usr/src/chdb-node-addon/lib", "-lchdb" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}

