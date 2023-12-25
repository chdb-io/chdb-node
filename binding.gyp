{
  "variables": {
    "openssl_fips": "",
  },
  "targets": [
    {
      "target_name": "action_before_build",
      "type": "none",
      "hard_dependency": 1,
      "actions": [
        {
          "action_name": "update_libchdb",
          "inputs": [],
          "outputs": [
            "<(module_root_dir)/libchdb.so"
          ],
          "action": ["./update_libchdb.sh"]
        }
      ]
    },
    {
      "target_name": "addon",
      "sources": [ "src/addon.cc" ],
      "dependencies": [
        "action_before_build"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include/"
      ],
      "libraries": [ "-L<(module_root_dir)", "-lchdb" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}

