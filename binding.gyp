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
        ["OS=='mac'", {
          "actions": [
            {
              "action_name": "postbuild",
              "inputs": [],
              "outputs": ["<(module_root_dir)/build/Release/postbuild_dummy"],
              "action": [
                "sh", "-c",
                "install_name_tool -change libchdb.so @loader_path/../../libchdb.so <(module_root_dir)/build/Release/chdb_node.node"
              ]
            }
          ]
        }]
      ]
    }
  ]
}