#!/bin/bash

cd "$(dirname "$0")"

if [[ $(uname -s) == "Darwin" ]]; then
    install_name_tool -change libchdb.so @loader_path/../../libchdb.so build/Release/chdb_node.node
    otool -L build/Release/chdb_node.node
fi
