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
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}