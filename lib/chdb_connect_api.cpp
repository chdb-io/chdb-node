
#include <napi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <iostream>

#include "LocalResultV2Wrapper.h"
#include "chdb.h"
#include "chdb_node.h"

// Wrapper to free_result_v2
void FreeResultV2(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() != 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected an external local_result_v2").ThrowAsJavaScriptException();
    return;
  }

  auto result = info[0].As<Napi::External<local_result_v2>>().Data();
  free_result_v2(result);
}

// Wrapper to connect_chdb
Napi::Value ConnectChdb(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected an array of arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array args = info[0].As<Napi::Array>();
  std::vector<char *> argv;
  for (size_t i = 0; i < args.Length(); i++) {
    argv.push_back((char *)args.Get(i).As<Napi::String>().Utf8Value().c_str());
  }

  auto conn = connect_chdb(argv.size(), argv.data());
  return Napi::External<chdb_conn>::New(env, *conn);
}

// Wrapper to close_conn
void CloseConn(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() != 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected an external chdb_conn")
        .ThrowAsJavaScriptException();
    return;
  }

  auto conn = info[0].As<Napi::External<chdb_conn>>().Data();
  close_conn(&conn);
}

// Wrapper to query_conn
Napi::Value QueryConn(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() != 3 || !info[0].IsExternal() || !info[2].IsString()) {
    Napi::TypeError::New(env, "Expected a connection, query (string or Buffer), and format string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  auto conn = info[0].As<Napi::External<chdb_conn>>().Data();

  // Extract query
  const char *queryData;
  local_result_v2 *result;
  std::string format = info[2].As<Napi::String>();
    std::cout << "buffer: " << std::endl;

  if (info[1].IsString()) {
    std::string query = info[1].As<Napi::String>();
    result = query_conn(conn, query.c_str(), format.c_str());
  } else if (info[1].IsBuffer()) {
    Napi::Buffer<char> buffer = info[1].As<Napi::Buffer<char>>();
    result = query_conn(conn,  buffer.Data(), format.c_str());
  } else {
    Napi::TypeError::New(env, "Query must be a string or a Buffer").ThrowAsJavaScriptException();
    return env.Null();
  }



  Napi::Object wrapper = LocalResultV2Wrapper::NewInstance(
      env, Napi::External<local_result_v2>::New(env, result));
  return wrapper;
}
