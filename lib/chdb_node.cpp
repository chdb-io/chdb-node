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
        std::size_t len = strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &tm);
        return std::string(buf, len);
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

// Parameterized query. Parameters are injected through prepended
// "SET param_<key> = '<value>'" statements so we can reuse the shared
// connection (chdb_query has no native parameter-binding API).
char *QueryBindSession(const char *query, const char *format, const char *path,
    const std::vector<std::string>& params, char **error_message) {

  std::string fullSql;
  const std::string prefix = "--param_";
  for (const auto& p : params) {
    if (p.compare(0, prefix.size(), prefix) != 0) continue;
    size_t eq = p.find('=', prefix.size());
    if (eq == std::string::npos) continue;
    std::string key = p.substr(prefix.size(), eq - prefix.size());
    std::string val = p.substr(eq + 1);
    fullSql += "SET param_" + key + " = " + chEscape(val) + "; ";
  }
  fullSql += query;

  #ifdef CHDB_DEBUG
  std::cerr << "=== chdb queryBind sql ===\n" << fullSql << '\n';
  #endif

  // path is currently always empty from the JS layer (Session.queryBind throws);
  // standalone queryBind always uses the shared default connection.
  (void)path;
  chdb_connection *conn_ptr = get_default_conn(error_message);
  if (!conn_ptr) return nullptr;
  return exec_query(*conn_ptr, fullSql.c_str(), format, error_message);
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
  exports.Set("QueryBindSession", Napi::Function::New(env, QueryBindSessionWrapper));

  // Export connection management functions
  exports.Set("CreateConnection", Napi::Function::New(env, CreateConnectionWrapper));
  exports.Set("CloseConnection", Napi::Function::New(env, CloseConnectionWrapper));
  exports.Set("QueryWithConnection", Napi::Function::New(env, QueryWithConnectionWrapper));

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
