

#include "LocalResultV2Wrapper.h"
#include "chdb_connect_api.h"
#include "chdb_node.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  LocalResultV2Wrapper::Init(env, exports);
  // Export the functions
  exports.Set("Query", Napi::Function::New(env, QueryWrapper));
  exports.Set("QuerySession", Napi::Function::New(env, QuerySessionWrapper));

  exports.Set(Napi::String::New(env, "freeResultV2"), Napi::Function::New(env, FreeResultV2));
  exports.Set(Napi::String::New(env, "connectChdb"), Napi::Function::New(env, ConnectChdb));
  exports.Set(Napi::String::New(env, "closeConn"), Napi::Function::New(env, CloseConn));
  exports.Set(Napi::String::New(env, "queryConn"), Napi::Function::New(env, QueryConn));

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)