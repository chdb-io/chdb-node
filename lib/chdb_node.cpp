#include "chdb.h"
#include "chdb_node.h"
#include <cstddef>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <iostream>
#include <napi.h>

typedef void * ChdbConnection;
ChdbConnection CreateConnection(const char * path);
void CloseConnection(ChdbConnection conn);
char * QueryWithConnection(ChdbConnection conn, const char * query, const char * format, char ** error_message);

#define MAX_FORMAT_LENGTH 64
#define MAX_PATH_LENGTH 4096
#define MAX_ARG_COUNT 6


static std::string toCHLiteral(const Napi::Env& env, const Napi::Value& v);


static std::string chEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 4);
    out += '\'';
    for (char c : s) {
        if (c == '\'') out += "\\'";
        else out += c;
    }
    out += '\'';
    return out;
}

static std::string toCHLiteral(const Napi::Env& env, const Napi::Value& v)
{
    if (v.IsNumber() || v.IsBoolean() || v.IsString())
        return v.ToString().Utf8Value();                 

    if (v.IsDate()) {                                    
        double ms = v.As<Napi::Date>().ValueOf();
        std::time_t t = static_cast<std::time_t>(ms / 1000);
        std::tm tm{};
        gmtime_r(&t, &tm);
        char buf[32];
        strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &tm);
        return std::string(&buf[0], sizeof(buf));
    }

    if (v.IsTypedArray()) {
        Napi::Object arr = env.Global().Get("Array").As<Napi::Object>();
        Napi::Function from = arr.Get("from").As<Napi::Function>();
        return toCHLiteral(env, from.Call(arr, { v }));
    }

    if (v.IsArray()) {
        Napi::Array a = v.As<Napi::Array>();
        size_t n = a.Length();
        std::string out = "[";
        for (size_t i = 0; i < n; ++i) {
            if (i) out += ",";
            out += toCHLiteral(env, a.Get(i));
        }
        out += "]";
        return out;
    }

    if (v.IsObject()) {
        Napi::Object o = v.As<Napi::Object>();
        Napi::Array keys = o.GetPropertyNames();
        size_t n = keys.Length();
        std::string out = "{";
        for (size_t i = 0; i < n; ++i) {
            if (i) out += ",";
            std::string k = keys.Get(i).ToString().Utf8Value();
            out += chEscape(k);               // escape the map key with single-qoutes for click house query to work i.e 'key' not "key"
            out += ":";
            out += toCHLiteral(env, o.Get(keys.Get(i)));
        }
        out += "}";
        return out;
    }

    /* Fallback – stringify & quote */
    return chEscape(v.ToString().Utf8Value());
}

// Utility function to construct argument string
void construct_arg(char *dest, const char *prefix, const char *value,
                   size_t dest_size) {
  snprintf(dest, dest_size, "%s%s", prefix, value);
}

// Generalized query function
char *general_query(int argc, char *args[], char **error_message) {
  struct local_result_v2 *result = query_stable_v2(argc, args);

  if (result == NULL) {
    return NULL;
  }

  if (result->error_message != NULL) {
    if (error_message != NULL) {
      *error_message = strdup(result->error_message);
    }
    free_result_v2(result);
    return NULL;
  } else {
    if (result->buf == NULL) {
      free_result_v2(result);
      return NULL;
    }
    char *output = strdup(result->buf); // copy the result buffer
    free_result_v2(result);
    return output;
  }
}

// Query function without session
char *Query(const char *query, const char *format, char **error_message) {
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

  char *result = general_query(argc, args, error_message);
  free(dataQuery);
  return result;
}

// QuerySession function will save the session to the path
char *QuerySession(const char *query, const char *format, const char *path,
                   char **error_message) {
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

  char *result = general_query(argc, args, error_message);
  free(dataQuery);
  return result;
}

char *QueryBindSession(const char *query, const char *format, const char *path, 
    const std::vector<std::string>& params, char **error_message) {

   std::vector<std::string> store;
    store.reserve(4 + params.size() + (path && path[0] ? 1 : 0));

    store.emplace_back("clickhouse");
    store.emplace_back("--multiquery");
    store.emplace_back(std::string("--output-format=") + format);
    store.emplace_back(std::string("--query=") + query);

    for (const auto& p : params) store.emplace_back(p);
    if (path && path[0])         store.emplace_back(std::string("--path=") + path);

    std::vector<char*> argv;
    argv.reserve(store.size());
    for (auto& s : store)
        argv.push_back(const_cast<char*>(s.c_str())); 

    #ifdef CHDB_DEBUG
    std::cerr << "=== chdb argv (" << argv.size() << ") ===\n";
    for (char* a : argv) std::cerr << a << '\n';
    #endif

    return query_stable_v2(static_cast<int>(argv.size()), argv.data())->buf;
}

ChdbConnection CreateConnection(const char * path) {
    char dataPath[MAX_PATH_LENGTH];
    char * args[MAX_ARG_COUNT] = {"clickhouse", NULL};
    int argc = 1;

    if (path && path[0]) {
        construct_arg(dataPath, "--path=", path, MAX_PATH_LENGTH);
        args[1] = dataPath;
        argc = 2;
    }

    return static_cast<ChdbConnection>(chdb_connect(argc, args));
}

void CloseConnection(ChdbConnection conn) {
    if (conn) {
        chdb_close_conn(static_cast<chdb_connection *>(conn));
    }
}

char * QueryWithConnection(ChdbConnection conn, const char * query, const char * format, char ** error_message) {
    if (!conn || !query || !format) {
        return nullptr;
    }

    chdb_connection * inner_conn = static_cast<chdb_connection *>(conn);
    chdb_result * result = chdb_query(*inner_conn, query, format);
    if (!result) {
        return nullptr;
    }

    const char * error = chdb_result_error(result);
    if (error) {
        if (error_message) {
            *error_message = strdup(error);
        }
        chdb_destroy_query_result(result);
        return nullptr;
    }

    const char * buffer = chdb_result_buffer(result);
    char * output = nullptr;
    if (buffer) {
        output = strdup(buffer);
    }

    chdb_destroy_query_result(result);
    return output;
}

Napi::String QueryWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }

  std::string query = info[0].As<Napi::String>().Utf8Value();
  std::string format = info[1].As<Napi::String>().Utf8Value();

  char *error_message = nullptr;

  char *result = Query(query.c_str(), format.c_str(), &error_message);

  if (result == NULL) {
    if (error_message != NULL) {
      Napi::Error::New(env, error_message).ThrowAsJavaScriptException();
      free(error_message);
    }
    return Napi::String::New(env, "");
  }

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

  char *error_message = nullptr;
  // Call the native function
  char *result =
      QuerySession(query.c_str(), format.c_str(), path.c_str(), &error_message);

  if (result == NULL) {
    if (error_message != NULL) {
      Napi::Error::New(env, error_message).ThrowAsJavaScriptException();
      free(error_message);
    }
    return Napi::String::New(env, "");
  }

  // Return the result
  return Napi::String::New(env, result);
}

static std::string jsToParam(const Napi::Env& env, const Napi::Value& v) {
    return toCHLiteral(env, v);
}

Napi::String QueryBindSessionWrapper(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject())
        Napi::TypeError::New(env,"Usage: sql, params, [format]").ThrowAsJavaScriptException();

    std::string sql    = info[0].As<Napi::String>();
    Napi::Object obj   = info[1].As<Napi::Object>();
    std::string format = (info.Length() > 2 && info[2].IsString())
                           ? info[2].As<Napi::String>() : std::string("CSV");
    std::string path = (info.Length() > 3 && info[3].IsString()) 
                          ? info[3].As<Napi::String>() : std::string("");

    // Build param vector
    std::vector<std::string> cliParams;
    Napi::Array keys = obj.GetPropertyNames();
    int len = keys.Length();
    for (int i = 0; i < len; i++) {
        Napi::Value k = keys.Get(i);
        if(!k.IsString()) continue;

        std::string key = k.As<Napi::String>();
        std::string val = jsToParam(env, obj.Get(k));
        cliParams.emplace_back("--param_" + key + "=" + val);
    }

    #ifdef CHDB_DEBUG
    std::cerr << "=== cliParams ===\n";
    for (const auto& s : cliParams)
        std::cerr << s << '\n';
    #endif

    char* err = nullptr;
    char* out = QueryBindSession(sql.c_str(), format.c_str(), path.c_str(), cliParams, &err);
    if (!out) {
        Napi::Error::New(env, err ? err : "unknown error").ThrowAsJavaScriptException();
        return Napi::String::New(env,"");
    }
    return Napi::String::New(env, out);
}

Napi::Value CreateConnectionWrapper(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Path string expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    ChdbConnection conn = CreateConnection(path.c_str());

    if (!conn) {
        Napi::Error::New(env, "Failed to create connection").ThrowAsJavaScriptException();
        return env.Null();
    }

    return Napi::External<void>::New(env, conn);
}

Napi::Value CloseConnectionWrapper(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsExternal()) {
        Napi::TypeError::New(env, "Connection handle expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    ChdbConnection conn = info[0].As<Napi::External<void>>().Data();
    CloseConnection(conn);

    return env.Undefined();
}

Napi::String QueryWithConnectionWrapper(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsExternal() || !info[1].IsString() || !info[2].IsString()) {
        Napi::TypeError::New(env, "Usage: connection, query, format").ThrowAsJavaScriptException();
        return Napi::String::New(env, "");
    }

    ChdbConnection conn = info[0].As<Napi::External<void>>().Data();
    std::string query = info[1].As<Napi::String>().Utf8Value();
    std::string format = info[2].As<Napi::String>().Utf8Value();

    char * error_message = nullptr;
    char * result = QueryWithConnection(conn, query.c_str(), format.c_str(), &error_message);

    if (error_message) {
        std::string error_msg = std::string("Query failed: ") + error_message;
        free(error_message);
        Napi::Error::New(env, error_msg).ThrowAsJavaScriptException();
        return Napi::String::New(env, "");
    }

    if (!result) {
        return Napi::String::New(env, "");
    }

    Napi::String output = Napi::String::New(env, result);
    free(result);
    return output;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Export the functions
  exports.Set("Query", Napi::Function::New(env, QueryWrapper));
  exports.Set("QuerySession", Napi::Function::New(env, QuerySessionWrapper));
  exports.Set("QueryBindSession", Napi::Function::New(env, QueryBindSessionWrapper));

  // Export connection management functions
  exports.Set("CreateConnection", Napi::Function::New(env, CreateConnectionWrapper));
  exports.Set("CloseConnection", Napi::Function::New(env, CloseConnectionWrapper));
  exports.Set("QueryWithConnection", Napi::Function::New(env, QueryWithConnectionWrapper));

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
