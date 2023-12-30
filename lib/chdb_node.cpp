#include "chdb.h"
#include "chdb_node.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <iostream>
#include <napi.h>

#define MAX_FORMAT_LENGTH 64
#define MAX_PATH_LENGTH 4096
#define MAX_ARG_COUNT 6

// Utility function to construct argument string
void construct_arg(char *dest, const char *prefix, const char *value,
                   size_t dest_size) {
  snprintf(dest, dest_size, "%s%s", prefix, value);
}

// Generalized query function
char *general_query(int argc, char *args[]) {
  struct local_result *result = query_stable(argc, args);

  if (result == NULL) {
    return NULL;
  } else {
    return result->buf;
  }
}

// Query function without session
char *Query(const char *query, const char *format) {
  char dataFormat[MAX_FORMAT_LENGTH];
  char *dataQuery;
  char *args[MAX_ARG_COUNT] = {"clickhouse", "--multiquery", NULL, NULL};
  int argc = 4;

  construct_arg(dataFormat, "--output-format=", format, MAX_FORMAT_LENGTH);
  args[2] = dataFormat;

  dataQuery = (char *)malloc(strlen(query) + strlen("--query=") + 1);
  if (dataQuery == NULL) {
    return NULL;
  }
  construct_arg(dataQuery, "--query=", query,
                strlen(query) + strlen("--query=") + 1);
  args[3] = dataQuery;

  char *result = general_query(argc, args);
  free(dataQuery);
  return result;
}

// QuerySession function will save the session to the path
// queries with same path will use the same session
char *QuerySession(const char *query, const char *format, const char *path) {
  char dataFormat[MAX_FORMAT_LENGTH];
  char dataPath[MAX_PATH_LENGTH];
  char *dataQuery;
  char *args[MAX_ARG_COUNT] = {"clickhouse", "--multiquery", NULL, NULL, NULL};
  int argc = 5;

  construct_arg(dataFormat, "--output-format=", format, MAX_FORMAT_LENGTH);
  args[2] = dataFormat;

  dataQuery = (char *)malloc(strlen(query) + strlen("--query=") + 1);
  if (dataQuery == NULL) {
    return NULL;
  }
  construct_arg(dataQuery, "--query=", query,
                strlen(query) + strlen("--query=") + 1);
  args[3] = dataQuery;

  construct_arg(dataPath, "--path=", path, MAX_PATH_LENGTH);
  args[4] = dataPath;

  char *result = general_query(argc, args);
  free(dataQuery);
  return result;
}

Napi::String QueryWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  // Check argument types and count
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }

  // Get the arguments
  std::string query = info[0].As<Napi::String>().Utf8Value();
  std::string format = info[1].As<Napi::String>().Utf8Value();

  // Call the native function
  char *result = Query(query.c_str(), format.c_str());

  // Return the result
  return Napi::String::New(env, result);
}

Napi::String QuerySessionWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  // Check argument types and count
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsString()) {
    Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }

  // Get the arguments
  std::string query = info[0].As<Napi::String>().Utf8Value();
  std::string format = info[1].As<Napi::String>().Utf8Value();
  std::string path = info[2].As<Napi::String>().Utf8Value();

  // std::cerr << query << std::endl;
  // std::cerr << format << std::endl;
  // std::cerr << path << std::endl;
  // Call the native function
  char *result = QuerySession(query.c_str(), format.c_str(), path.c_str());
  if (result == NULL) {
    // std::cerr << "result is null" << std::endl;
    return Napi::String::New(env, "");
  }

  // Return the result
  return Napi::String::New(env, result);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Export the functions
  exports.Set("Query", Napi::Function::New(env, QueryWrapper));
  exports.Set("QuerySession", Napi::Function::New(env, QuerySessionWrapper));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
