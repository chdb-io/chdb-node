#include "chdb.h"
#include "chdb_node.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <iostream>
#include <memory>
#include <mutex>
#include <set>
#include <unordered_map>
#include <utility>
#include <vector>
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

// Connection registry. chdb-core runs ONE process-wide EmbeddedServer bound to a
// single data directory (path): the first connect() binds it, a later connect()
// to the SAME path attaches another independent client to that server, and a
// connect() to a DIFFERENT path while one is live is rejected by the engine
// (BAD_ARGUMENTS: "EmbeddedServer already initialized with path ..."). The server
// unbinds when its last connection closes, after which a different path may bind.
//
// This registry mirrors that model. Unlike the previous single-slot design (which
// refcount-collapsed every same-path Session onto ONE shared connection), it now
// keeps each connection as a DISTINCT chdb_connection handle, so:
//   - N connections to the same path coexist and run NON-PARAMETERIZED queries
//     in parallel (each chdb-core client has its own per-instance
//     ChdbClient::client_mutex, so distinct connections never serialize against
//     each other);
//   - a different data directory is still rejected while one is bound;
//   - same-path Sessions no longer silently share one native connection (which
//     was a latent clobber: two Sessions had separate JS param chains but one
//     underlying connection).
//
// PARAMETERIZED queries are NOT parallelized today: the bundled libchdb does not
// isolate parameter set/reset per connection under true parallelism (concurrent
// param queries on different connections clobber each other, surfacing as
// `456 Substitution not set` and can fatally abort the engine `236`). The JS
// layer serializes ALL parameterized async queries through one process-wide
// chain (see `globalParamChain` in index.js); non-parameterized queries are
// unaffected and keep full parallelism.
//
// The path key is normalized to an absolute path by the JS layer (path.resolve)
// so "./data" and the absolute form bind the same server. The lazily-created
// default in-memory connection (key "") serves standalone query()/queryBind()
// and yields to a session when one opens (matching v2 behaviour).
//
// The canonical handle passed around is the `chdb_connection*` returned by
// chdb_connect (dereferenced for chdb_query, passed as-is to chdb_close_conn),
// matching the External handle layout v2 exposed to JS.
//
// Thread-safety: registry mutations happen on the Node main thread (the N-API
// wrappers below), so they are already serialized by the event loop; queries run
// on libuv worker threads but only touch a connection handle, never this registry.
// g_reg_mu is a defensive guard so the invariants hold even if a future caller
// mutates the registry off the main thread.
struct Registry {
  std::string boundKey;                  // path the EmbeddedServer is bound to (valid while !conns.empty())
  std::set<chdb_connection *> conns;     // every live connection (sessions + the default)
  chdb_connection *defaultConn = nullptr; // the lazy in-memory default (key ""), if up
};
static Registry g_reg;
static std::mutex g_reg_mu;

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

// Arrow-table registry cleanup (defined alongside g_live_arrow_tables below).
// A connection's pinned JS buffers live in that registry keyed by the raw
// chdb_connection*, so they must be dropped when the connection closes — else
// they leak for the life of the process, the engine retains dangling refs, and
// a later reused connection address could collide with the stale key.
static void erase_arrow_tables_for_conn(chdb_connection *conn);
static void clear_all_arrow_tables();

// Close every live connection. atexit backstop (the JS layer closes sessions on
// 'exit' too); also used so a leaked connection never outlives the process.
static void hard_close_all() {
  std::lock_guard<std::mutex> lk(g_reg_mu);
  clear_all_arrow_tables();
  for (chdb_connection *c : g_reg.conns) {
    if (c) chdb_close_conn(c);
  }
  g_reg.conns.clear();
  g_reg.defaultConn = nullptr;
  g_reg.boundKey.clear();
}

static void ensure_atexit() {
  static bool done = false;
  if (!done) {
    std::atexit(hard_close_all);
    done = true;
  }
}

// Default connection for standalone query()/queryBind() (lazy, in-memory). A
// single shared default per process; reused across standalone calls.
static chdb_connection *get_default_conn(char **error_message) {
  ensure_atexit();
  std::lock_guard<std::mutex> lk(g_reg_mu);
  if (g_reg.defaultConn) return g_reg.defaultConn;
  // No default up. If a session holds a real data directory, "" cannot bind a
  // second one (one EmbeddedServer path per process) — reject, as v2 did.
  if (!g_reg.conns.empty()) {
    if (error_message && !*error_message)
      *error_message = strdup((std::string("chdb: a session (path='") + g_reg.boundKey +
                               "') is active; close it before using standalone query()").c_str());
    return nullptr;
  }
  chdb_connection *c = open_raw("");
  if (!c) {
    if (error_message && !*error_message)
      *error_message = strdup("Failed to acquire default connection");
    return nullptr;
  }
  g_reg.defaultConn = c;
  g_reg.boundKey = "";
  g_reg.conns.insert(c);
  return c;
}

// Session connection: same bound path opens ANOTHER independent connection; a
// live in-memory default yields; a different data directory is rejected.
static chdb_connection *acquire_session_conn(const std::string &path, char **error_message) {
  ensure_atexit();
  std::lock_guard<std::mutex> lk(g_reg_mu);
  if (!g_reg.conns.empty()) {
    if (g_reg.boundKey.empty()) {
      // Only the in-memory default is up (boundKey ""). It is transient and must
      // yield so this session can bind a real data directory.
      if (g_reg.defaultConn) {
        erase_arrow_tables_for_conn(g_reg.defaultConn);
        chdb_close_conn(g_reg.defaultConn);
        g_reg.conns.erase(g_reg.defaultConn);
        g_reg.defaultConn = nullptr;
      }
      // conns is now empty; fall through to bind `path`.
    } else if (g_reg.boundKey != path) {
      if (error_message && !*error_message)
        *error_message = strdup((std::string("chdb: only one active data directory per "
                                 "process; close the current session (path='") + g_reg.boundKey +
                                 "') before opening '" + path + "'").c_str());
      return nullptr;
    }
    // else boundKey == path: an independent connection to the same server.
  }
  chdb_connection *c = open_raw(path);
  if (!c) {
    if (error_message && !*error_message)
      *error_message = strdup((std::string("Failed to create connection for path '") + path + "'").c_str());
    return nullptr;
  }
  g_reg.boundKey = path;
  g_reg.conns.insert(c);
  return c;
}

static void release_session_conn(chdb_connection *conn) {
  if (!conn) return;
  std::lock_guard<std::mutex> lk(g_reg_mu);
  auto it = g_reg.conns.find(conn);
  if (it == g_reg.conns.end()) return; // already released / unknown handle
  // Drop any Arrow tables pinned on this connection before closing it, so the
  // JS buffer references aren't orphaned in g_live_arrow_tables.
  erase_arrow_tables_for_conn(conn);
  chdb_close_conn(conn);
  g_reg.conns.erase(it);
  if (conn == g_reg.defaultConn) g_reg.defaultConn = nullptr;
  // Last connection out unbinds the EmbeddedServer so a different path may bind.
  if (g_reg.conns.empty()) g_reg.boundKey.clear();
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
// Raw-format passthrough insert. The payload stays a JS Buffer (V8
// off-heap); this worker pins it with a Persistent reference, assembles
// "INSERT INTO ... FORMAT <fmt>\n<data>" on the libuv thread (the main thread
// never copies or scans the payload), and executes via the length-aware
// chdb_query_n (binary-safe: embedded NUL bytes survive).
//
// Ownership ledger:
//   - payload Buffer: pinned by bufRef_ (constructed on the main thread);
//     released when the worker is destroyed on the main thread after
//     OnOK/OnError. The caller must not mutate the Buffer until the returned
//     promise settles (same contract as fs.write).
//   - assembled sql std::string: Execute()-local, freed on return. Peak memory
//     during the call is ~2x payload until an upstream two-buffer entry lands.
//   - chdb_result: destroyed inside Execute().
//
// rowsSent (payload-side ledger): for line-delimited formats the worker counts
// non-empty lines off-thread — exact, because those formats escape raw '\n'
// inside values. rowsWritten/bytesWritten (engine-side ledger) come from
// chdb_result_rows_written/bytes_written (chdb-io/chdb-core#88) and include cascaded
// materialized-view writes.
//===--------------------------------------------------------------------===//
class InsertRawWorker : public Napi::AsyncWorker {
public:
  InsertRawWorker(Napi::Env env, chdb_connection conn, std::string prefix,
                  Napi::Buffer<char> data, bool countLines)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
        conn_(conn), prefix_(std::move(prefix)),
        dataPtr_(data.Data()), dataLen_(data.Length()), countLines_(countLines) {
    bufRef_ = Napi::Persistent(data.As<Napi::Object>());
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    std::string sql;
    sql.reserve(prefix_.size() + 1 + dataLen_);
    sql.append(prefix_);
    sql.push_back('\n');
    sql.append(dataPtr_, dataLen_);

    if (countLines_) {
      // Count non-empty lines (a line holding only whitespace is skipped by
      // the engine's row parsers, so it is not a row).
      bool content = false;
      for (size_t i = 0; i < dataLen_; i++) {
        char c = dataPtr_[i];
        if (c == '\n') {
          if (content) linesSent_++;
          content = false;
        } else if (c != '\r' && c != ' ' && c != '\t') {
          content = true;
        }
      }
      if (content) linesSent_++; // final line without a trailing newline
    }

    chdb_result *result = chdb_query_n(conn_, sql.data(), sql.size(), "CSV", 3);
    if (!result) { SetError("chdb query returned a null result"); return; }
    const char *error = chdb_result_error(result);
    if (error) {
      std::string msg = error;
      chdb_destroy_query_result(result);
      SetError(msg);
      return;
    }
    elapsed_ = chdb_result_elapsed(result);
    rowsWritten_ = chdb_result_rows_written(result);
    bytesWritten_ = chdb_result_bytes_written(result);
    chdb_destroy_query_result(result);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Napi::Object res = Napi::Object::New(env);
    res.Set("elapsed", Napi::Number::New(env, elapsed_));
    res.Set("rowsWritten", Napi::Number::New(env, static_cast<double>(rowsWritten_)));
    res.Set("bytesWritten", Napi::Number::New(env, static_cast<double>(bytesWritten_)));
    if (countLines_)
      res.Set("rowsSent", Napi::Number::New(env, static_cast<double>(linesSent_)));
    deferred_.Resolve(res);
  }

  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  chdb_connection conn_;
  std::string prefix_;
  const char *dataPtr_;
  size_t dataLen_;
  bool countLines_;
  Napi::ObjectReference bufRef_; // released on the main thread in the worker dtor
  double elapsed_ = 0.0;
  uint64_t rowsWritten_ = 0, bytesWritten_ = 0, linesSent_ = 0;
};

// Standalone raw insert (default connection). Args: (prefix, dataBuffer, countLines)
Napi::Value InsertRawAsyncWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsBuffer() || !info[2].IsBoolean()) {
    Napi::TypeError::New(env, "Usage: prefix, dataBuffer, countLines").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string prefix = info[0].As<Napi::String>();

  char *err = nullptr;
  chdb_connection *conn_ptr = get_default_conn(&err); // registry: main thread only
  if (!conn_ptr) {
    Napi::Value p = rejectedPromise(env, err ? err : "Failed to acquire default connection");
    if (err) free(err);
    return p;
  }
  auto *worker = new InsertRawWorker(env, *conn_ptr, std::move(prefix),
                                     info[1].As<Napi::Buffer<char>>(),
                                     info[2].As<Napi::Boolean>().Value());
  worker->Queue();
  return worker->GetPromise();
}

// Session raw insert. Args: (connection, prefix, dataBuffer, countLines)
Napi::Value InsertRawAsyncConnectionWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsExternal() || !info[1].IsString() || !info[2].IsBuffer()
      || !info[3].IsBoolean()) {
    Napi::TypeError::New(env, "Usage: connection, prefix, dataBuffer, countLines").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection *inner = static_cast<chdb_connection *>(info[0].As<Napi::External<void>>().Data());
  if (!inner) return rejectedPromise(env, "No active connection available");
  std::string prefix = info[1].As<Napi::String>();
  auto *worker = new InsertRawWorker(env, *inner, std::move(prefix),
                                     info[2].As<Napi::Buffer<char>>(),
                                     info[3].As<Napi::Boolean>().Value());
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

// Args: (connection, sql, format[, paramsObj]) -> External<StreamState>
// When paramsObj is present, the stream is opened with server-side parameter
// binding (chdb_stream_query_with_params_n) — values are pre-formatted to param
// strings by the JS layer and never spliced into the SQL, exactly like the
// one-shot QueryWithParams path. Otherwise the plain (param-less) stream opens.
Napi::Value StreamQueryWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsExternal() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, sql, format[, params]").ThrowAsJavaScriptException();
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

  const bool hasParams = info.Length() >= 4 && info[3].IsObject();
  chdb_result *handle;
  if (hasParams) {
    std::vector<std::string> names, values;
    if (!collectParams(info[3].As<Napi::Object>(), names, values)) {
      Napi::TypeError::New(env, "param values must be pre-formatted strings").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    size_t n = names.size();
    std::vector<const char *> cnames(n), cvalues(n);
    std::vector<size_t> vlens(n);
    for (size_t i = 0; i < n; i++) {
      cnames[i] = names[i].c_str();
      cvalues[i] = values[i].data();
      vlens[i] = values[i].size();
    }
    handle = chdb_stream_query_with_params_n(
        conn, sql.data(), sql.size(), format.data(), format.size(),
        n ? cnames.data() : nullptr, nullptr /* name lens => strlen */,
        n ? cvalues.data() : nullptr, n ? vlens.data() : nullptr, n);
  } else {
    handle = chdb_stream_query_n(conn, sql.data(), sql.size(), format.data(), format.size());
  }
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

//===---------------------------------------------------------------------===//
// Arrow C Data Interface — caller-built struct layout.
//
// The standard Arrow ABI structs are reproduced here so the addon doesn't have
// to depend on `arrow/c/abi.h` (chdb ships with Arrow linked inside libchdb but
// does not re-expose the header). Layout matches the spec at
// https://arrow.apache.org/docs/format/CDataInterface.html so a chdb-side
// `reinterpret_cast<ArrowArrayStream *>` matches our pointers byte-for-byte.
//===---------------------------------------------------------------------===//

struct AbiSchema {
  const char * format;
  const char * name;
  const char * metadata;
  int64_t flags;
  int64_t n_children;
  AbiSchema ** children;
  AbiSchema * dictionary;
  void (*release)(AbiSchema *);
  void * private_data;
};

struct AbiArray {
  int64_t length;
  int64_t null_count;
  int64_t offset;
  int64_t n_buffers;
  int64_t n_children;
  const void ** buffers;
  AbiArray ** children;
  AbiArray * dictionary;
  void (*release)(AbiArray *);
  void * private_data;
};

// No-op release callbacks. chdb-arrow.cpp saves each child's release into a
// vector before scanning, then restores it; passing NULL would segfault there.
static void AbiSchemaNoopRelease(AbiSchema * s) { s->release = nullptr; }
static void AbiArrayNoopRelease(AbiArray * a) { a->release = nullptr; }

//===---------------------------------------------------------------------===//
// Arrow C Data Interface bindings.
//
// chdb_arrow_scan / chdb_arrow_array_scan let the engine read a caller-built
// Arrow buffer as if it were a regular table (the table function is registered
// under a chosen name; SELECT * FROM <name> reads it). The wire types declared
// in chdb.h are opaque, but chdb-arrow.cpp inside libchdb just reinterprets
// them as the standard ArrowSchema * / ArrowArray * / ArrowArrayStream * from
// the Arrow C Data Interface — so JS hands the addon a pointer (BigInt) to a
// caller-owned, correctly-laid-out struct, and the addon forwards it.
//
// Memory: the caller owns the struct and its referenced buffers until the
// matching Unregister. chdb keeps a stable reference to the data in its own
// ArrowStreamRegistry; on Unregister chdb releases its hold and we free the
// caller-side wrapper (typed-array references included).
//===---------------------------------------------------------------------===//

// Resolve the connection arg: undefined/null -> default in-process connection;
// External<void> -> a Session-bound chdb_connection*. Throws a JS exception
// and returns false on a misuse / no-default-available error.
static bool resolveArrowConn(Napi::Env env, Napi::Value handle, chdb_connection ** out) {
  if (handle.IsExternal()) {
    *out = static_cast<chdb_connection *>(handle.As<Napi::External<void>>().Data());
    if (*out == nullptr) {
      Napi::Error::New(env, "Connection handle is null (closed?)").ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  if (handle.IsNull() || handle.IsUndefined()) {
    char * err = nullptr;
    chdb_connection * c = get_default_conn(&err);
    if (c == nullptr) {
      std::string msg = err ? err : "no default connection available";
      if (err) free(err);
      Napi::Error::New(env, msg).ThrowAsJavaScriptException();
      return false;
    }
    *out = c;
    return true;
  }
  Napi::TypeError::New(env, "Connection must be a Session handle or null").ThrowAsJavaScriptException();
  return false;
}

// Pull a `BigInt` off the call info as a raw pointer. JS hands us 64-bit
// pointers losslessly through BigInt; anything else is a misuse.
static bool pointerArg(Napi::Env env, Napi::Value v, const char * field, uint64_t * out) {
  if (!v.IsBigInt()) {
    Napi::TypeError::New(env, std::string(field) + " must be a BigInt pointer").ThrowAsJavaScriptException();
    return false;
  }
  bool lossless = false;
  *out = v.As<Napi::BigInt>().Uint64Value(&lossless);
  if (!lossless) {
    Napi::TypeError::New(env, std::string(field) + " BigInt did not convert losslessly").ThrowAsJavaScriptException();
    return false;
  }
  if (*out == 0) {
    Napi::Error::New(env, std::string(field) + " pointer is null").ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// nativeArrowRegisterArray(conn, tableName, schemaPtr, arrayPtr)
//   schemaPtr / arrayPtr are JS-owned ArrowSchema * / ArrowArray * (BigInt).
//   chdb takes a snapshot via chdb_arrow_array_scan and registers the table.
Napi::Value ArrowRegisterArrayWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, tableName, schemaPtr, arrayPtr").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();
  uint64_t schemaPtr = 0, arrayPtr = 0;
  if (!pointerArg(env, info[2], "schemaPtr", &schemaPtr)) return env.Undefined();
  if (!pointerArg(env, info[3], "arrayPtr", &arrayPtr)) return env.Undefined();

  chdb_state st = chdb_arrow_array_scan(
      *conn,
      tableName.c_str(),
      reinterpret_cast<chdb_arrow_schema>(static_cast<uintptr_t>(schemaPtr)),
      reinterpret_cast<chdb_arrow_array>(static_cast<uintptr_t>(arrayPtr)));
  if (st != CHDBSuccess) {
    Napi::Error::New(env, "chdb_arrow_array_scan failed for table " + tableName).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return env.Undefined();
}

// nativeArrowRegisterStream(conn, tableName, streamPtr) — for multi-batch data.
Napi::Value ArrowRegisterStreamWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, tableName, streamPtr").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();
  uint64_t streamPtr = 0;
  if (!pointerArg(env, info[2], "streamPtr", &streamPtr)) return env.Undefined();

  chdb_state st = chdb_arrow_scan(
      *conn,
      tableName.c_str(),
      reinterpret_cast<chdb_arrow_stream>(static_cast<uintptr_t>(streamPtr)));
  if (st != CHDBSuccess) {
    Napi::Error::New(env, "chdb_arrow_scan failed for table " + tableName).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return env.Undefined();
}

//===---------------------------------------------------------------------===//
// High-level table registration. JS hands the addon a list of column
// descriptors (`name`, Arrow format string, plain Buffers / TypedArrays for
// validity / data / offsets), and the addon assembles the ArrowSchema and
// ArrowArray children + struct root so chdb can read the data with no IPC
// round-trip and no Arrow header dependency on the JS side.
//
// Lifetime: chdb keeps a reference inside its own ArrowStreamRegistry, so the
// underlying byte buffers (held by JS) must stay alive until Unregister is
// called. We keep both the C structs and Napi::Reference handles to each JS
// Buffer pinned in a per-(connection, tableName) live-registration record.
//===---------------------------------------------------------------------===//

struct ArrowColumnBuffers {
  std::vector<Napi::Reference<Napi::Value>> jsRefs;  // pin each JS buffer
  std::vector<std::vector<const void *>> bufferPtrs; // one per column (validity/data/offsets)
};

struct LiveArrowTable {
  std::string format;                // "+s" + child format strings (owned strings below)
  std::vector<std::string> formatStorage;
  std::vector<std::string> nameStorage;
  // Children are stored contiguously and pointed at via pointer-arrays below.
  std::vector<AbiSchema> childSchemas;
  std::vector<AbiArray> childArrays;
  std::vector<AbiSchema *> childSchemaPtrs;
  std::vector<AbiArray *> childArrayPtrs;
  AbiSchema rootSchema{};
  AbiArray rootArray{};
  std::vector<const void *> rootBuffers;             // root struct: one null bitmap (NULL)
  ArrowColumnBuffers buffers;
};

// Key: (connection pointer, table name). Lookup on unregister to free.
using LiveArrowKey = std::pair<chdb_connection *, std::string>;
struct LiveArrowKeyHash {
  size_t operator()(const LiveArrowKey & k) const noexcept {
    return std::hash<void *>{}(k.first) ^ std::hash<std::string>{}(k.second);
  }
};
static std::unordered_map<LiveArrowKey, std::unique_ptr<LiveArrowTable>, LiveArrowKeyHash> g_live_arrow_tables;
static std::mutex g_live_arrow_mu;

// Drop every registered Arrow table belonging to `conn`, releasing the pinned
// JS buffer references and C-side struct storage. Called from the connection
// close paths so a session closed without an explicit Unregister doesn't leak.
static void erase_arrow_tables_for_conn(chdb_connection *conn) {
  std::lock_guard<std::mutex> lock(g_live_arrow_mu);
  for (auto it = g_live_arrow_tables.begin(); it != g_live_arrow_tables.end();) {
    if (it->first.first == conn) it = g_live_arrow_tables.erase(it);
    else ++it;
  }
}

// Drop the entire registry (process teardown backstop).
static void clear_all_arrow_tables() {
  std::lock_guard<std::mutex> lock(g_live_arrow_mu);
  g_live_arrow_tables.clear();
}

// nativeArrowRegisterColumns(conn, tableName, columns)
//   columns: Array<{ name, format, length, nullCount, buffers: Array<Buffer|null> }>
//     - format: an Arrow C Data Interface format string ("i"/"l"/"g"/"b"/"u"/...)
//     - buffers[0] = validity bitmap (null if nullCount === 0)
//     - buffers[1] = data
//     - buffers[2] = offsets (utf8 only)
Napi::Value ArrowRegisterColumnsWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "Usage: connection, tableName, columns[]").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();
  Napi::Array columns = info[2].As<Napi::Array>();
  uint32_t ncols = columns.Length();
  if (ncols == 0) {
    Napi::TypeError::New(env, "registerArrowTable: at least one column required").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto live = std::make_unique<LiveArrowTable>();
  live->formatStorage.reserve(ncols);
  live->nameStorage.reserve(ncols);
  live->childSchemas.resize(ncols);
  live->childArrays.resize(ncols);
  live->childSchemaPtrs.resize(ncols);
  live->childArrayPtrs.resize(ncols);
  live->buffers.bufferPtrs.resize(ncols);

  int64_t rootLength = 0;
  bool rootLengthSet = false;

  for (uint32_t i = 0; i < ncols; i++) {
    Napi::Value colv = columns[i];
    if (!colv.IsObject()) {
      Napi::TypeError::New(env, "Each column must be an object").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object col = colv.As<Napi::Object>();
    Napi::Value nameV = col.Get("name");
    Napi::Value formatV = col.Get("format");
    Napi::Value lengthV = col.Get("length");
    Napi::Value nullCountV = col.Get("nullCount");
    Napi::Value buffersV = col.Get("buffers");
    if (!nameV.IsString() || !formatV.IsString() || !lengthV.IsNumber() || !buffersV.IsArray()) {
      Napi::TypeError::New(env, "Column needs { name, format, length, buffers }").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    live->nameStorage.emplace_back(nameV.As<Napi::String>().Utf8Value());
    live->formatStorage.emplace_back(formatV.As<Napi::String>().Utf8Value());
    int64_t length = lengthV.As<Napi::Number>().Int64Value();
    int64_t nullCount = nullCountV.IsNumber() ? nullCountV.As<Napi::Number>().Int64Value() : 0;
    // Reject negatives explicitly: a negative length flows straight into
    // ArrowArray.length, and a negative nullCount mismatches the validity bitmap.
    if (length < 0 || nullCount < 0) {
      Napi::TypeError::New(env, "Column length and nullCount must be non-negative").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // A separate flag (not a -1 sentinel) so a column whose length is legitimately
    // any value, including 0, sets the root length on the first column.
    if (!rootLengthSet) {
      rootLength = length;
      rootLengthSet = true;
    } else if (rootLength != length) {
      Napi::TypeError::New(env, "All columns must have the same length").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    Napi::Array bufs = buffersV.As<Napi::Array>();
    uint32_t nbufs = bufs.Length();
    std::vector<const void *> ptrs;
    ptrs.reserve(nbufs);
    for (uint32_t b = 0; b < nbufs; b++) {
      Napi::Value bv = bufs[b];
      if (bv.IsNull() || bv.IsUndefined()) {
        ptrs.push_back(nullptr);
        continue;
      }
      if (!bv.IsBuffer()) {
        Napi::TypeError::New(env, "Column buffers must be Node Buffers or null").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      Napi::Buffer<uint8_t> buf = bv.As<Napi::Buffer<uint8_t>>();
      ptrs.push_back(buf.Data());
      // Pin the JS Buffer so its underlying data stays alive until Unregister.
      live->buffers.jsRefs.push_back(Napi::Reference<Napi::Value>::New(bv, 1));
    }
    live->buffers.bufferPtrs[i] = std::move(ptrs);

    // Child ArrowSchema.
    AbiSchema & cs = live->childSchemas[i];
    cs = {};
    cs.format = live->formatStorage.back().c_str();
    cs.name = live->nameStorage.back().c_str();
    cs.metadata = nullptr;
    cs.flags = 2;  // ARROW_FLAG_NULLABLE
    cs.n_children = 0;
    cs.children = nullptr;
    cs.dictionary = nullptr;
    cs.release = AbiSchemaNoopRelease;
    cs.private_data = nullptr;
    live->childSchemaPtrs[i] = &cs;

    // Child ArrowArray.
    AbiArray & ca = live->childArrays[i];
    ca = {};
    ca.length = length;
    ca.null_count = nullCount;
    ca.offset = 0;
    ca.n_buffers = static_cast<int64_t>(live->buffers.bufferPtrs[i].size());
    ca.n_children = 0;
    ca.buffers = live->buffers.bufferPtrs[i].data();
    ca.children = nullptr;
    ca.dictionary = nullptr;
    ca.release = AbiArrayNoopRelease;
    ca.private_data = nullptr;
    live->childArrayPtrs[i] = &ca;
  }

  // Root struct schema.
  live->format = "+s";
  live->rootSchema = {};
  live->rootSchema.format = live->format.c_str();
  live->rootSchema.name = "";
  live->rootSchema.metadata = nullptr;
  live->rootSchema.flags = 0;
  live->rootSchema.n_children = ncols;
  live->rootSchema.children = live->childSchemaPtrs.data();
  live->rootSchema.dictionary = nullptr;
  live->rootSchema.release = AbiSchemaNoopRelease;
  live->rootSchema.private_data = nullptr;

  // Root struct array. Struct layout has exactly one buffer slot (validity);
  // we pass NULL to indicate no nulls at the row level.
  live->rootBuffers = { nullptr };
  live->rootArray = {};
  live->rootArray.length = rootLength;
  live->rootArray.null_count = 0;
  live->rootArray.offset = 0;
  live->rootArray.n_buffers = 1;
  live->rootArray.n_children = ncols;
  live->rootArray.buffers = live->rootBuffers.data();
  live->rootArray.children = live->childArrayPtrs.data();
  live->rootArray.dictionary = nullptr;
  live->rootArray.release = AbiArrayNoopRelease;
  live->rootArray.private_data = nullptr;

  chdb_state st = chdb_arrow_array_scan(
      *conn,
      tableName.c_str(),
      reinterpret_cast<chdb_arrow_schema>(&live->rootSchema),
      reinterpret_cast<chdb_arrow_array>(&live->rootArray));
  if (st != CHDBSuccess) {
    Napi::Error::New(env, "chdb_arrow_array_scan failed for table " + tableName).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  {
    std::lock_guard<std::mutex> lock(g_live_arrow_mu);
    LiveArrowKey key{ conn, tableName };
    // Replace any prior entry — Unregister would otherwise leak the old refs.
    g_live_arrow_tables[key] = std::move(live);
  }
  return env.Undefined();
}

// nativeArrowUnregister(conn, tableName) — drops the registry entry.
Napi::Value ArrowUnregisterWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, tableName").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();

  chdb_state st = chdb_arrow_unregister_table(*conn, tableName.c_str());
  if (st != CHDBSuccess) {
    Napi::Error::New(env, "chdb_arrow_unregister_table failed for table " + tableName).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Drop the JS-buffer pins and the C-side struct storage. After chdb's
  // unregister returns, the engine no longer reaches our buffers, so freeing
  // them is safe.
  {
    std::lock_guard<std::mutex> lock(g_live_arrow_mu);
    g_live_arrow_tables.erase(LiveArrowKey{ conn, tableName });
  }
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Export the functions
  exports.Set("Query", Napi::Function::New(env, QueryWrapper));
  exports.Set("QueryWithParams", Napi::Function::New(env, QueryWithParamsWrapper));
  exports.Set("QueryWithParamsConnection", Napi::Function::New(env, QueryWithParamsConnectionWrapper));

  // Async query (AsyncWorker -> Promise)
  exports.Set("QueryAsync", Napi::Function::New(env, QueryAsyncWrapper));
  exports.Set("QueryAsyncConnection", Napi::Function::New(env, QueryAsyncConnectionWrapper));

  // Raw-format passthrough insert
  exports.Set("InsertRawAsync", Napi::Function::New(env, InsertRawAsyncWrapper));
  exports.Set("InsertRawAsyncConnection", Napi::Function::New(env, InsertRawAsyncConnectionWrapper));

  // Streaming query
  exports.Set("StreamQuery", Napi::Function::New(env, StreamQueryWrapper));
  exports.Set("StreamFetch", Napi::Function::New(env, StreamFetchWrapper));
  exports.Set("StreamCancel", Napi::Function::New(env, StreamCancelWrapper));

  // Export connection management functions
  exports.Set("CreateConnection", Napi::Function::New(env, CreateConnectionWrapper));
  exports.Set("CloseConnection", Napi::Function::New(env, CloseConnectionWrapper));
  exports.Set("QueryWithConnection", Napi::Function::New(env, QueryWithConnectionWrapper));

  // Arrow C Data Interface bindings.
  exports.Set("ArrowRegisterArray", Napi::Function::New(env, ArrowRegisterArrayWrapper));
  exports.Set("ArrowRegisterStream", Napi::Function::New(env, ArrowRegisterStreamWrapper));
  exports.Set("ArrowRegisterColumns", Napi::Function::New(env, ArrowRegisterColumnsWrapper));
  exports.Set("ArrowUnregister", Napi::Function::New(env, ArrowUnregisterWrapper));

  // Most-reliable exit cleanup: close every live connection on env teardown,
  // ahead of (and complementary to) the std::atexit backstop. Both call the
  // idempotent hard_close_all, so running twice is harmless.
  env.AddCleanupHook([] { hard_close_all(); });

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
