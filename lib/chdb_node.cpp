#include "chdb.h"
#include "chdb_node.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <iostream>
#include <napi.h>

typedef void * ChdbConnection;
ChdbConnection CreateConnection(const char * path, char ** error_message);
void CloseConnection(ChdbConnection conn);
char * QueryWithConnection(ChdbConnection conn, const char * query, const char * format, char ** error_message);

#define MAX_FORMAT_LENGTH 64
#define MAX_PATH_LENGTH 4096
#define MAX_ARG_COUNT 6


// NOTE: the v2 chEscape/toCHLiteral SET-param machinery has been removed.
// Parameter binding now goes through libchdb's server-side chdb_query_with_params
// (Item 5 / path A): values are bound by the engine, never interpolated into SQL,
// so there is no string-escaping attack surface at all. The JS layer formats each
// value to its param-string form (src/serialize.ts: formatParamValue).

// Connection registry (design §3.2). chDB / libchdb allow only ONE active
// connection per process; this registry is the single owner of that constraint.
// It tracks the one live connection by a canonical key, reference-counts session
// handles, and REJECTS a second concurrent data directory rather than silently
// switching (silent switching was the #17 crash source). The lazily-created
// default in-memory connection serves standalone query()/queryBind() and yields
// to a session when one opens (matching v2's release_default_conn behaviour).
//
// The canonical handle passed around is the `chdb_connection*` returned by
// chdb_connect (dereferenced for chdb_query, passed as-is to chdb_close_conn),
// matching the External handle layout v2 exposed to JS.
struct ActiveConn {
  chdb_connection *conn = nullptr;  // chdb_connect() result, or nullptr
  std::string key;                  // "" = default in-memory; otherwise the path
  int refcount = 0;                 // open Session handles (default is transient)
  bool isDefault = false;
};
static ActiveConn g_active;

static chdb_connection *open_raw(const std::string &path) {
  char prog[] = "clickhouse";
  std::string pathArg;
  char *args[2] = { prog, nullptr };
  int argc = 1;
  if (!path.empty()) {
    pathArg = "--path=" + path;
    args[1] = const_cast<char *>(pathArg.c_str());
    argc = 2;
  }
  chdb_connection *conn_ptr = chdb_connect(argc, args);
  return (conn_ptr && *conn_ptr) ? conn_ptr : nullptr;
}

static void hard_close_active() {
  if (g_active.conn) {
    chdb_close_conn(g_active.conn);
  }
  g_active.conn = nullptr;
  g_active.key.clear();
  g_active.refcount = 0;
  g_active.isDefault = false;
}

static void ensure_atexit() {
  static bool done = false;
  if (!done) {
    std::atexit(hard_close_active);
    done = true;
  }
}

// Default connection for standalone query()/queryBind() (lazy, in-memory).
static chdb_connection *get_default_conn(char **error_message) {
  ensure_atexit();
  if (g_active.conn) {
    if (g_active.isDefault) return g_active.conn;
    if (error_message && !*error_message)
      *error_message = strdup((std::string("chdb: a session (path='") + g_active.key +
                               "') is active; close it before using standalone query()").c_str());
    return nullptr;
  }
  chdb_connection *c = open_raw("");
  if (!c) {
    if (error_message && !*error_message)
      *error_message = strdup("Failed to acquire default connection");
    return nullptr;
  }
  g_active.conn = c;
  g_active.key = "";
  g_active.refcount = 0;
  g_active.isDefault = true;
  return c;
}

// Session connection: same path reuses (refcount++); a live default yields; a
// different active data directory is rejected (not silently switched).
static chdb_connection *acquire_session_conn(const std::string &path, char **error_message) {
  ensure_atexit();
  if (g_active.conn) {
    if (!g_active.isDefault && g_active.key == path) {
      g_active.refcount++;
      return g_active.conn;
    }
    if (g_active.isDefault) {
      hard_close_active();
    } else {
      if (error_message && !*error_message)
        *error_message = strdup((std::string("chdb: only one active data directory per "
                                 "process; close the current session (path='") + g_active.key +
                                 "') before opening '" + path + "'").c_str());
      return nullptr;
    }
  }
  chdb_connection *c = open_raw(path);
  if (!c) {
    if (error_message && !*error_message)
      *error_message = strdup((std::string("Failed to create connection for path '") + path + "'").c_str());
    return nullptr;
  }
  g_active.conn = c;
  g_active.key = path;
  g_active.refcount = 1;
  g_active.isDefault = false;
  return c;
}

static void release_session_conn(chdb_connection *conn) {
  if (!conn) return;
  if (g_active.conn == conn && !g_active.isDefault) {
    if (--g_active.refcount <= 0) hard_close_active();
  }
}

static char *exec_query(chdb_connection conn, const char *query,
                        const char *format, char **error_message) {
  if (!conn) {
    if (error_message && !*error_message)
      *error_message = strdup("Failed to acquire default connection");
    return nullptr;
  }
  chdb_result *result = chdb_query(conn, query, format);
  if (!result) return nullptr;

  const char *error = chdb_result_error(result);
  if (error) {
    if (error_message) *error_message = strdup(error);
    chdb_destroy_query_result(result);
    return nullptr;
  }

  const char *buffer = chdb_result_buffer(result);
  char *output = buffer ? strdup(buffer) : nullptr;
  chdb_destroy_query_result(result);
  return output;
}

// Query function without session (uses the registry default connection)
char *Query(const char *query, const char *format, char **error_message) {
  chdb_connection *conn_ptr = get_default_conn(error_message);
  if (!conn_ptr) return nullptr;
  return exec_query(*conn_ptr, query, format, error_message);
}

// Server-side parameter binding (Item 5 / path A). Values are pre-formatted to
// param strings by the JS layer; the engine resolves each type from the
// {name:Type} placeholder. Binary-safe (uses *_params_n with explicit value
// lengths) so String params may contain embedded null bytes.
static char *exec_query_params(chdb_connection conn,
                               const std::string &query,
                               const std::string &format,
                               const std::vector<std::string> &names,
                               const std::vector<std::string> &values,
                               char **error_message) {
  if (!conn) {
    if (error_message && !*error_message)
      *error_message = strdup("Failed to acquire default connection");
    return nullptr;
  }
  size_t n = names.size();
  std::vector<const char *> cnames(n), cvalues(n);
  std::vector<size_t> vlens(n);
  for (size_t i = 0; i < n; i++) {
    cnames[i] = names[i].c_str();
    cvalues[i] = values[i].data();
    vlens[i] = values[i].size();
  }
  chdb_result *result = chdb_query_with_params_n(
      conn, query.data(), query.size(), format.data(), format.size(),
      n ? cnames.data() : nullptr, nullptr /* name lens => strlen */,
      n ? cvalues.data() : nullptr, n ? vlens.data() : nullptr, n);
  if (!result) return nullptr;

  const char *error = chdb_result_error(result);
  if (error) {
    if (error_message) *error_message = strdup(error);
    chdb_destroy_query_result(result);
    return nullptr;
  }
  const char *buffer = chdb_result_buffer(result);
  char *output = buffer ? strdup(buffer) : nullptr;
  chdb_destroy_query_result(result);
  return output;
}

ChdbConnection CreateConnection(const char * path, char ** error_message) {
    // Sessions always pass a real path (a temp dir for in-memory sessions), so
    // an empty key here never collides with the default connection's "" key.
    std::string p = (path && path[0]) ? std::string(path) : std::string();
    return static_cast<ChdbConnection>(acquire_session_conn(p, error_message));
}

void CloseConnection(ChdbConnection conn) {
    release_session_conn(static_cast<chdb_connection *>(conn));
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

// Collect a JS params object { name: preformattedString } into parallel
// name/value vectors. Values MUST already be strings (the JS layer runs
// formatParamValue before calling in), so the native side never re-derives
// CH literals.
static bool collectParams(const Napi::Object &obj,
                          std::vector<std::string> &names,
                          std::vector<std::string> &values) {
  Napi::Array keys = obj.GetPropertyNames();
  uint32_t len = keys.Length();
  for (uint32_t i = 0; i < len; i++) {
    Napi::Value k = keys.Get(i);
    Napi::Value v = obj.Get(k);
    if (!v.IsString()) return false;
    names.push_back(k.ToString().Utf8Value());
    values.push_back(v.As<Napi::String>().Utf8Value());
  }
  return true;
}

// Standalone parameterized query (default connection).
// Args: (sql, format, paramsObj)
Napi::String QueryWithParamsWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsObject()) {
    Napi::TypeError::New(env, "Usage: sql, format, params").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }
  std::string sql = info[0].As<Napi::String>();
  std::string format = info[1].As<Napi::String>();
  std::vector<std::string> names, values;
  if (!collectParams(info[2].As<Napi::Object>(), names, values)) {
    Napi::TypeError::New(env, "param values must be pre-formatted strings").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }

  char *err = nullptr;
  chdb_connection *conn_ptr = get_default_conn(&err);
  char *out = conn_ptr ? exec_query_params(*conn_ptr, sql, format, names, values, &err) : nullptr;
  if (!out) {
    if (err) { Napi::Error::New(env, err).ThrowAsJavaScriptException(); free(err); }
    return Napi::String::New(env, "");
  }
  Napi::String r = Napi::String::New(env, out);
  free(out);
  return r;
}

// Session parameterized query (explicit connection).
// Args: (connection, sql, format, paramsObj)
Napi::String QueryWithParamsConnectionWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsExternal() || !info[1].IsString() || !info[2].IsString() || !info[3].IsObject()) {
    Napi::TypeError::New(env, "Usage: connection, sql, format, params").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }
  ChdbConnection conn = info[0].As<Napi::External<void>>().Data();
  std::string sql = info[1].As<Napi::String>();
  std::string format = info[2].As<Napi::String>();
  std::vector<std::string> names, values;
  if (!collectParams(info[3].As<Napi::Object>(), names, values)) {
    Napi::TypeError::New(env, "param values must be pre-formatted strings").ThrowAsJavaScriptException();
    return Napi::String::New(env, "");
  }

  chdb_connection *inner = static_cast<chdb_connection *>(conn);
  char *err = nullptr;
  char *out = inner ? exec_query_params(*inner, sql, format, names, values, &err) : nullptr;
  if (!out) {
    if (err) { Napi::Error::New(env, err).ThrowAsJavaScriptException(); free(err); }
    return Napi::String::New(env, "");
  }
  Napi::String r = Napi::String::New(env, out);
  free(out);
  return r;
}

Napi::Value CreateConnectionWrapper(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Path string expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    char *error_message = nullptr;
    ChdbConnection conn = CreateConnection(path.c_str(), &error_message);

    if (!conn) {
        std::string msg = error_message ? error_message : "Failed to create connection";
        if (error_message) free(error_message);
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
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
  exports.Set("QueryWithParams", Napi::Function::New(env, QueryWithParamsWrapper));
  exports.Set("QueryWithParamsConnection", Napi::Function::New(env, QueryWithParamsConnectionWrapper));

  // Export connection management functions
  exports.Set("CreateConnection", Napi::Function::New(env, CreateConnectionWrapper));
  exports.Set("CloseConnection", Napi::Function::New(env, CloseConnectionWrapper));
  exports.Set("QueryWithConnection", Napi::Function::New(env, QueryWithConnectionWrapper));

  // Most-reliable exit cleanup (§10): close the active connection on env
  // teardown, ahead of (and complementary to) the std::atexit backstop. Both
  // call the idempotent hard_close_active, so running twice is harmless.
  env.AddCleanupHook([] { hard_close_active(); });

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
