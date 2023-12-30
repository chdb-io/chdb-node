{
  "variables": {
    "openssl_fips": "",
  },
  "targets": [
    {
      "target_name": "chdb_node",
      "sources": [ "lib/chdb_node.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "lib/"
      ],
      "libraries": [ "-L<(module_root_dir)/lib", "-lchdb" ],
      # "cflags!": [ "-fno-exceptions" ],
      # "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}

