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


// NOTE: the previous chEscape/toCHLiteral SET-param machinery has been removed.
// Parameter binding now goes through libchdb's server-side chdb_query_with_params:
// values are bound by the engine, never interpolated into SQL, so there is no
// string-escaping attack surface at all. The JS layer formats each value to its
// param-string form (src/serialize.ts: formatParamValue). Because parameters are
// applied per call and reset by the engine afterwards, there is no shared mutable
// param state between calls (unlike the old session-wide "SET param_x=" path,
// which could race when different callers set different values).

// Connection registry. chDB / libchdb allow only ONE active connection per
// process; this registry is the single owner of that constraint. It tracks the
// one live connection by its path key, reference-counts session handles for the
// same path (so reopening the same path returns the same connection while it is
// live), and REJECTS a second concurrent data directory rather than silently
// switching (silent switching caused the malloc crash on repeated start/stop).
// The path key is normalized to an absolute path by the JS layer (path.resolve)
// so "./data" and the absolute form map to the same connection; symlink-level
// canonicalization is a possible future refinement. The lazily-created default
// in-memory connection serves standalone query()/queryBind() and yields
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

// Server-side parameter binding. Values are pre-formatted to param strings by
// the JS layer; the engine resolves each type from the {name:Type} placeholder
// and the parameters are scoped to this single call. Binary-safe (uses
// *_params_n with explicit value lengths) so String params may contain embedded
// null bytes.
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
  if (!result) {
    // A null result is a failure, not an empty success: surface it so the
    // caller throws instead of silently returning "". Mirrors the async path
    // (QueryAsyncWorker::Execute), which already SetError()s on a null result.
    if (error_message && !*error_message)
      *error_message = strdup("chdb query returned a null result");
    return nullptr;
  }

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

//===--------------------------------------------------------------------===//
// Async query (Napi::AsyncWorker) — runs chdb_query{,_with_params_n} on the
// libuv thread pool so the event loop is never frozen. Returns a Promise that
// resolves to { bytes, elapsed, rowsRead, bytesRead } or rejects with the
// native error message (the JS layer maps it to a typed ChdbError).
//
// Honest single-shot cancellation: there is no interrupt for chdb_query,
// so AbortSignal/timeout are handled JS-side (reject early; the native thread
// runs to completion and its result is discarded). The connection handle is
// resolved on the main thread (registry is not touched off-thread).
//===--------------------------------------------------------------------===//
class QueryAsyncWorker : public Napi::AsyncWorker {
public:
  QueryAsyncWorker(Napi::Env env, chdb_connection conn, std::string sql, std::string format,
                   bool hasParams, std::vector<std::string> names, std::vector<std::string> values)
      : Napi::AsyncWorker(env),
        deferred_(Napi::Promise::Deferred::New(env)),
        conn_(conn), sql_(std::move(sql)), format_(std::move(format)),
        hasParams_(hasParams), names_(std::move(names)), values_(std::move(values)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    chdb_result *result;
    if (hasParams_) {
      size_t n = names_.size();
      std::vector<const char *> cnames(n), cvalues(n);
      std::vector<size_t> vlens(n);
      for (size_t i = 0; i < n; i++) {
        cnames[i] = names_[i].c_str();
        cvalues[i] = values_[i].data();
        vlens[i] = values_[i].size();
      }
      result = chdb_query_with_params_n(
          conn_, sql_.data(), sql_.size(), format_.data(), format_.size(),
          n ? cnames.data() : nullptr, nullptr,
          n ? cvalues.data() : nullptr, n ? vlens.data() : nullptr, n);
    } else {
      result = chdb_query_n(conn_, sql_.data(), sql_.size(), format_.data(), format_.size());
    }
    if (!result) { SetError("chdb query returned a null result"); return; }
    const char *error = chdb_result_error(result);
    if (error) {
      std::string msg = error;
      chdb_destroy_query_result(result);
      SetError(msg);
      return;
    }
    size_t len = chdb_result_length(result);
    const char *buf = chdb_result_buffer(result);
    if (buf && len) data_.assign(buf, buf + len);
    elapsed_ = chdb_result_elapsed(result);
    rowsRead_ = chdb_result_rows_read(result);
    bytesRead_ = chdb_result_bytes_read(result);
    chdb_destroy_query_result(result);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Napi::Object res = Napi::Object::New(env);
    res.Set("bytes", Napi::Buffer<char>::Copy(env, data_.data(), data_.size()));
    res.Set("elapsed", Napi::Number::New(env, elapsed_));
    res.Set("rowsRead", Napi::Number::New(env, static_cast<double>(rowsRead_)));
    res.Set("bytesRead", Napi::Number::New(env, static_cast<double>(bytesRead_)));
    deferred_.Resolve(res);
  }

  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  chdb_connection conn_;
  std::string sql_, format_;
  bool hasParams_;
  std::vector<std::string> names_, values_;
  std::vector<char> data_;
  double elapsed_ = 0.0;
  uint64_t rowsRead_ = 0, bytesRead_ = 0;
};

static Napi::Value rejectedPromise(Napi::Env env, const char *msg) {
  auto def = Napi::Promise::Deferred::New(env);
  def.Reject(Napi::Error::New(env, msg).Value());
  return def.Promise();
}

// Standalone async query. Args: (sql, format, paramsObjOrNull)
Napi::Value QueryAsyncWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: sql, format, [params]").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string sql = info[0].As<Napi::String>();
  std::string format = info[1].As<Napi::String>();
  bool hasParams = info.Length() > 2 && info[2].IsObject();
  std::vector<std::string> names, values;
  if (hasParams && !collectParams(info[2].As<Napi::Object>(), names, values))
    return rejectedPromise(env, "param values must be pre-formatted strings");

  char *err = nullptr;
  chdb_connection *conn_ptr = get_default_conn(&err); // registry: main thread only
  if (!conn_ptr) {
    Napi::Value p = rejectedPromise(env, err ? err : "Failed to acquire default connection");
    if (err) free(err);
    return p;
  }
  auto *worker = new QueryAsyncWorker(env, *conn_ptr, std::move(sql), std::move(format),
                                      hasParams, std::move(names), std::move(values));
  worker->Queue();
  return worker->GetPromise();
}

// Session async query. Args: (connection, sql, format, paramsObjOrNull)
Napi::Value QueryAsyncConnectionWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsExternal() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, sql, format, [params]").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  ChdbConnection conn = info[0].As<Napi::External<void>>().Data();
  chdb_connection *inner = static_cast<chdb_connection *>(conn);
  if (!inner) return rejectedPromise(env, "No active connection available");
  std::string sql = info[1].As<Napi::String>();
  std::string format = info[2].As<Napi::String>();
  bool hasParams = info.Length() > 3 && info[3].IsObject();
  std::vector<std::string> names, values;
  if (hasParams && !collectParams(info[3].As<Napi::Object>(), names, values))
    return rejectedPromise(env, "param values must be pre-formatted strings");

  auto *worker = new QueryAsyncWorker(env, *inner, std::move(sql), std::move(format),
                                      hasParams, std::move(names), std::move(values));
  worker->Queue();
  return worker->GetPromise();
}

//===--------------------------------------------------------------------===//
// Streaming query (chdb_stream_query / _fetch_result / _cancel_query). Each
// fetch runs on the libuv thread pool so it does not block the event loop. It
// copies each chunk into a JS Buffer and destroys the native chunk immediately
// (simple, no use-after-free); true zero-copy is a later optimization.
//===--------------------------------------------------------------------===//
struct StreamState {
  chdb_connection conn;   // dereferenced handle
  chdb_result *handle;    // stream handle from chdb_stream_query
  bool finished;
};

static void stream_close(StreamState *st) {
  if (st && !st->finished && st->handle) {
    chdb_stream_cancel_query(st->conn, st->handle);
    chdb_destroy_query_result(st->handle);
    st->handle = nullptr;
    st->finished = true;
  }
}

// Args: (connection, sql, format) -> External<StreamState>
Napi::Value StreamQueryWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsExternal() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, sql, format").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection *connPtr = static_cast<chdb_connection *>(info[0].As<Napi::External<void>>().Data());
  if (!connPtr) {
    Napi::Error::New(env, "No active connection available").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection conn = *connPtr;
  std::string sql = info[1].As<Napi::String>();
  std::string format = info[2].As<Napi::String>();

  chdb_result *handle = chdb_stream_query_n(conn, sql.data(), sql.size(), format.data(), format.size());
  if (!handle) {
    Napi::Error::New(env, "chdb stream query returned a null handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const char *err = chdb_result_error(handle);
  if (err) {
    std::string msg = err;
    chdb_destroy_query_result(handle);
    Napi::Error::New(env, msg).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto *st = new StreamState{conn, handle, false};
  return Napi::External<StreamState>::New(env, st, [](Napi::Env, StreamState *p) {
    stream_close(p);
    delete p;
  });
}

class StreamFetchWorker : public Napi::AsyncWorker {
public:
  StreamFetchWorker(Napi::Env env, StreamState *st)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), st_(st) {}
  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    if (!st_ || st_->finished || !st_->handle) { done_ = true; return; }
    chdb_result *chunk = chdb_stream_fetch_result(st_->conn, st_->handle);
    if (!chunk) { finish(); return; }
    const char *err = chdb_result_error(chunk);
    if (err) {
      std::string msg = err;
      chdb_destroy_query_result(chunk);
      finish();
      SetError(msg);
      return;
    }
    size_t len = chdb_result_length(chunk);
    if (len == 0) { chdb_destroy_query_result(chunk); finish(); return; }
    const char *buf = chdb_result_buffer(chunk);
    data_.assign(buf, buf + len);
    numRows_ = chdb_result_rows_read(chunk);
    chdb_destroy_query_result(chunk);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Napi::Object res = Napi::Object::New(env);
    res.Set("bytes", Napi::Buffer<char>::Copy(env, data_.data(), data_.size()));
    res.Set("numRows", Napi::Number::New(env, static_cast<double>(numRows_)));
    res.Set("done", Napi::Boolean::New(env, done_));
    deferred_.Resolve(res);
  }
  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

private:
  // End of stream: destroy the handle once and mark finished.
  void finish() {
    done_ = true;
    if (st_ && st_->handle) {
      chdb_destroy_query_result(st_->handle);
      st_->handle = nullptr;
      st_->finished = true;
    }
  }
  Napi::Promise::Deferred deferred_;
  StreamState *st_;
  std::vector<char> data_;
  uint64_t numRows_ = 0;
  bool done_ = false;
};

// Args: (streamHandle) -> Promise<{ bytes, numRows, done }>
Napi::Value StreamFetchWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsExternal())
    return rejectedPromise(env, "Usage: streamHandle");
  StreamState *st = info[0].As<Napi::External<StreamState>>().Data();
  auto *worker = new StreamFetchWorker(env, st);
  worker->Queue();
  return worker->GetPromise();
}

// Args: (streamHandle) -> undefined
Napi::Value StreamCancelWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() >= 1 && info[0].IsExternal())
    stream_close(info[0].As<Napi::External<StreamState>>().Data());
  return env.Undefined();
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

  // Async query (AsyncWorker -> Promise)
  exports.Set("QueryAsync", Napi::Function::New(env, QueryAsyncWrapper));
  exports.Set("QueryAsyncConnection", Napi::Function::New(env, QueryAsyncConnectionWrapper));

  // Streaming query
  exports.Set("StreamQuery", Napi::Function::New(env, StreamQueryWrapper));
  exports.Set("StreamFetch", Napi::Function::New(env, StreamFetchWrapper));
  exports.Set("StreamCancel", Napi::Function::New(env, StreamCancelWrapper));

  // Export connection management functions
  exports.Set("CreateConnection", Napi::Function::New(env, CreateConnectionWrapper));
  exports.Set("CloseConnection", Napi::Function::New(env, CloseConnectionWrapper));
  exports.Set("QueryWithConnection", Napi::Function::New(env, QueryWithConnectionWrapper));

  // Most-reliable exit cleanup: close the active connection on env
  // teardown, ahead of (and complementary to) the std::atexit backstop. Both
  // call the idempotent hard_close_active, so running twice is harmless.
  env.AddCleanupHook([] { hard_close_active(); });

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
