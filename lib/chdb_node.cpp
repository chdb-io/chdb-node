#include "chdb.h"
#include "chdb_node.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <iostream>
#include <memory>
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <optional>
#include <set>
#include <unordered_map>
#include <utility>
#include <vector>
#include <napi.h>

typedef void * ChdbConnection;
ChdbConnection CreateConnection(const char * path, char ** error_message);
ChdbConnection CreateConnectionWithArgs(const char * path,
                                        const std::vector<std::string> & extraArgs,
                                        char ** error_message);
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
// Thread-safety: each N-API wrapper runs on its isolate's event loop; several
// worker_threads can mutate this process-wide registry concurrently. g_reg_mu
// serializes those changes. libuv query workers only touch retained handles.
struct Registry {
  std::string boundKey;                  // path the EmbeddedServer is bound to (valid while !conns.empty())
  std::set<chdb_connection *> conns;     // every live connection (sessions + the default)
  chdb_connection *defaultConn = nullptr; // the lazy in-memory default (key ""), if up
};
static Registry g_reg;
static std::mutex g_reg_mu;
static std::unordered_map<chdb_connection *, napi_env> g_conn_owner;

// Extra argv entries are the same `--setting=value` forms a `clickhouse local`
// invocation takes, and they have to be given at connect: `--path` and
// `--backups.allowed_path` are server configuration rather than session
// settings, and a durable writer's `SET`-equivalents must not be reachable
// afterwards (the durable control plane classifies `SET` as CONTROL and
// refuses it, so a caller cannot undo them through its public surface).
//
// Every entry is checked for an embedded NUL first. A JS string may hold one,
// and `c_str()` hands the engine everything before it — so an argument that
// looks like "--path\0anything" arrives as a bare "--path", an option that
// takes the NEXT argv as its value, and the following entry becomes the data
// directory. Measured: `['--path\0x', '/other']` bound /other while the
// registry recorded the requested path, which is precisely the mismatch this
// bookkeeping exists to prevent. CreateConnectionWrapper refuses these with a
// message; this is the backstop for any future caller that reaches here
// without going through it.
static chdb_connection *open_raw(const std::string &path,
                                 const std::vector<std::string> &extraArgs = {}) {
  if (path.find('\0') != std::string::npos) return nullptr;
  for (const std::string &a : extraArgs) {
    if (a.find('\0') != std::string::npos) return nullptr;
  }

  std::vector<std::string> owned;
  owned.reserve(extraArgs.size() + 2);
  owned.emplace_back("clickhouse");
  if (!path.empty()) owned.push_back("--path=" + path);
  for (const std::string &a : extraArgs) owned.push_back(a);

  std::vector<char *> args;
  args.reserve(owned.size() + 1);
  for (std::string &a : owned) args.push_back(const_cast<char *>(a.c_str()));
  args.push_back(nullptr);

  chdb_connection *conn_ptr = chdb_connect(static_cast<int>(owned.size()), args.data());
  return (conn_ptr && *conn_ptr) ? conn_ptr : nullptr;
}

//===--------------------------------------------------------------------===//
// In-flight accounting, so a connection is never closed under a running call.
//
// Closing one while a libuv thread is still inside libchdb on it is not
// survivable: the engine aborts for the rest of the process, and on macOS the
// worker can stay blocked so its promise never settles — an unexplained hang
// somewhere later.
//
// The JS layer already guarded the one path it owns (index.js refuses
// `new Session()` while a standalone async op is in flight). But that guard
// sits ABOVE the addon, so every new entry point has to remember it
// independently — and `chdb/durable/node`, which reaches CreateConnection
// directly, did not. A guard that each caller must re-implement is a guard
// that the next caller will miss.
//
// So the count lives here, beside the registry whose invariant it protects,
// and every entry point gets it whether or not it knows. Each AsyncWorker
// holds a ConnGuard: its constructor runs on the main thread and the framework
// deletes the worker on the main thread after OnOK/OnError, so retain and
// release are both serialized by the event loop and can never straddle
// Execute().
//
// Scope is a worker actively inside libchdb. An *open* stream whose fetch is
// not running holds no thread, so closing under it fails the stream rather
// than corrupting the process; index.js's pendingNativeOps covers that case.
//
// Scope also stops at eviction. release_session_conn does NOT consult this
// count, so an explicit CloseConnection on a busy handle is still the
// caller's problem to avoid — and both callers do: index.js defers teardown
// while pendingNativeOps is non-empty, and the durable adapter's close()
// waits out its own in-flight set before releasing. Left that way
// deliberately: the count would have to defer the close rather than refuse
// it, since CloseConnection returns void and index.js does not expect it to
// fail, and neither existing caller can reach the bug. A third caller that
// closes a busy handle directly would, so this is the line to move if one
// appears.
//===--------------------------------------------------------------------===//
static std::unordered_map<chdb_connection, int> g_inflight;

static void retain_conn(chdb_connection conn) {
  if (!conn) return;
  std::lock_guard<std::mutex> lk(g_reg_mu);
  g_inflight[conn]++;
}

static void release_conn(chdb_connection conn) {
  if (!conn) return;
  std::lock_guard<std::mutex> lk(g_reg_mu);
  auto it = g_inflight.find(conn);
  if (it == g_inflight.end()) return;
  if (--it->second <= 0) g_inflight.erase(it);
}

// Caller must already hold g_reg_mu: the count is read as part of an eviction
// decision, and reading it separately would let a worker start in between.
static int inflight_locked(chdb_connection conn) {
  auto it = g_inflight.find(conn);
  return it == g_inflight.end() ? 0 : it->second;
}

// Held as a member by every worker that touches a connection off-thread.
class ConnGuard {
public:
  explicit ConnGuard(chdb_connection conn) : conn_(conn) { retain_conn(conn_); }
  ~ConnGuard() { release_conn(conn_); }
  ConnGuard(const ConnGuard &) = delete;
  ConnGuard &operator=(const ConnGuard &) = delete;

private:
  chdb_connection conn_;
};

// Arrow-table registry cleanup (defined alongside g_live_arrow_tables below).
// A connection's pinned JS buffers live in that registry keyed by the raw
// chdb_connection*, so they must be dropped when the connection closes — else
// they leak for the life of the process, the engine retains dangling refs, and
// a later reused connection address could collide with the stale key.
static void erase_arrow_tables_for_conn(chdb_connection *conn);
static void clear_all_arrow_tables();

// Close every live connection. atexit backstop (the JS layer closes sessions and
// calls ExitTeardownWrapper on 'exit' first); also used so a leaked connection
// never outlives the process.
static void hard_close_all() {
  std::lock_guard<std::mutex> lk(g_reg_mu);
  clear_all_arrow_tables();
  for (chdb_connection *c : g_reg.conns) {
    if (c) chdb_close_conn(c);
  }
  g_reg.conns.clear();
  g_conn_owner.clear();
  g_reg.defaultConn = nullptr;
  g_reg.boundKey.clear();
}

// The atexit backstop: close whatever is still open when the process reaches C
// exit(), then stop the engine, so it owns no background threads while C++
// static destructors run. On macOS with core v26.9.0, a CLI that queried once
// could hang indefinitely inside exit() without it.
//
// It is only the fallback. index.js calls ExitTeardownWrapper (below) from the
// process 'exit' event, which closes everything it safely can before exit().
// atexit handlers and static destructors run in reverse order of registration,
// and this one is registered once, at the first connect, so it runs after two
// things registered later: the exit teardown the engine registers on every
// start (since chdb-core v26.11.0-rc.2), so after an engine restart that runs
// first, and every function-local static constructed after the first connect,
// including ones a query or a MergeTree merge constructed. Closing a connection
// here tears the server down onto those destroyed statics; with merges in
// flight, a process.exit() on the default connection crashed in this handler.
//
// chdb_shutdown() is one of them: it keeps a function-local static mutex,
// constructed by its first call. Once ExitTeardownWrapper has called it, a
// second call from here locks that mutex after its destructor ran, which macOS
// reports as "mutex lock failed: Invalid argument" and aborts. So the exit
// paths call it once between them.
static std::atomic<bool> g_exit_shutdown_called{false};

static void shutdown_engine_once() {
  if (!g_exit_shutdown_called.exchange(true)) (void)chdb_shutdown();
}

static void shutdown_on_process_exit() {
  hard_close_all();
  shutdown_engine_once();
}

// Set at the first connect. Guarded by g_reg_mu: both callers hold it.
static bool g_atexit_registered = false;

// Environments that loaded the addon and have not been torn down: the main
// thread, and each worker_threads Worker that required it. Init counts one in,
// its env cleanup hook counts it out. ExitTeardownWrapper reads it.
static std::atomic<int> g_live_envs{0};

static void close_for_env(napi_env owner) {
  std::lock_guard<std::mutex> lk(g_reg_mu);
  for (auto it = g_reg.conns.begin(); it != g_reg.conns.end();) {
    chdb_connection * conn = *it;
    auto found = g_conn_owner.find(conn);
    if (found == g_conn_owner.end() || found->second != owner) { ++it; continue; }
    erase_arrow_tables_for_conn(conn);
    chdb_close_conn(conn);
    g_conn_owner.erase(found);
    if (g_reg.defaultConn == conn) g_reg.defaultConn = nullptr;
    it = g_reg.conns.erase(it);
  }
  if (g_reg.conns.empty()) g_reg.boundKey.clear();
}

static void ensure_atexit() {
  if (!g_atexit_registered) {
    std::atexit(shutdown_on_process_exit);
    g_atexit_registered = true;
  }
}

// Default connection for standalone query()/queryBind() (lazy, in-memory). A
// single shared default per process; reused across standalone calls.
static chdb_connection *get_default_conn(char **error_message, napi_env owner) {
  std::lock_guard<std::mutex> lk(g_reg_mu);
  if (g_reg.defaultConn) {
    auto found = g_conn_owner.find(g_reg.defaultConn);
    if (found != g_conn_owner.end() && found->second != owner) {
      if (error_message && !*error_message)
        *error_message = strdup("Default connection belongs to another Node isolate; use a Session");
      return nullptr;
    }
    return g_reg.defaultConn;
  }
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
  g_conn_owner[c] = owner;
  g_reg.boundKey = "";
  g_reg.conns.insert(c);
  // Register only after chdb_connect started the engine, so the backstop runs
  // before the exit teardown that start registered (see shutdown_on_process_exit
  // for what it still runs after).
  ensure_atexit();
  return c;
}

// Session connection: same bound path opens ANOTHER independent connection; a
// live in-memory default yields; a different data directory is rejected.
static chdb_connection *acquire_session_conn(const std::string &path,
                                            const std::vector<std::string> &extraArgs,
                                            char **error_message) {
  std::lock_guard<std::mutex> lk(g_reg_mu);
  if (!g_reg.conns.empty()) {
    if (g_reg.boundKey.empty()) {
      // Only the in-memory default is up (boundKey ""). It is transient and must
      // yield so this session can bind a real data directory — but not while a
      // libuv thread is still inside libchdb on it. This is the check every
      // entry point used to have to make for itself; making it here is what
      // makes it apply to all of them.
      if (g_reg.defaultConn) {
        int busy = inflight_locked(*g_reg.defaultConn);
        if (busy > 0) {
          if (error_message && !*error_message)
            *error_message = strdup(
                (std::string("chdb: cannot bind '") + path + "' while " + std::to_string(busy) +
                 (busy == 1 ? " operation is" : " operations are") +
                 " still running on the default connection. Binding a data directory closes "
                 "that connection, and closing it mid-operation aborts the engine for the "
                 "whole process. Await those operations first — or `await drainPending()`, "
                 "since an aborted or timed-out call rejects straight away while the engine "
                 "keeps computing, so there may be no promise left to await.")
                    .c_str());
          return nullptr;
        }
        erase_arrow_tables_for_conn(g_reg.defaultConn);
        chdb_close_conn(g_reg.defaultConn);
        g_conn_owner.erase(g_reg.defaultConn);
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
  chdb_connection *c = open_raw(path, extraArgs);
  if (!c) {
    if (error_message && !*error_message)
      *error_message = strdup((std::string("Failed to create connection for path '") + path + "'").c_str());
    return nullptr;
  }
  g_reg.boundKey = path;
  g_reg.conns.insert(c);
  ensure_atexit();
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
  g_conn_owner.erase(conn);
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
char *Query(const char *query, const char *format, char **error_message, napi_env owner) {
  chdb_connection *conn_ptr = get_default_conn(error_message, owner);
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
    return CreateConnectionWithArgs(path, {}, error_message);
}

ChdbConnection CreateConnectionWithArgs(const char * path,
                                        const std::vector<std::string> & extraArgs,
                                        char ** error_message) {
    // Sessions always pass a real path (a temp dir for in-memory sessions), so
    // an empty key here never collides with the default connection's "" key.
    std::string p = (path && path[0]) ? std::string(path) : std::string();
    return static_cast<ChdbConnection>(acquire_session_conn(p, extraArgs, error_message));
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

  char *result = Query(query.c_str(), format.c_str(), &error_message, env);

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
  chdb_connection *conn_ptr = get_default_conn(&err, env);
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
        hasParams_(hasParams), names_(std::move(names)), values_(std::move(values)),
        guard_(conn) {}

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
  ConnGuard guard_;
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
  chdb_connection *conn_ptr = get_default_conn(&err, env);
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
        dataPtr_(data.Data()), dataLen_(data.Length()), countLines_(countLines),
        guard_(conn) {
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
  ConnGuard guard_;
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
  chdb_connection *conn_ptr = get_default_conn(&err, env);
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
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), st_(st),
        guard_(st ? st->conn : nullptr) {}
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
  ConnGuard guard_;
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

// Args: (path, settings[]?) — settings are extra argv entries such as
// "--backups.allowed_path=/…" or "--async_insert=0". The durable engine
// adapter is the caller that needs them; every other caller passes none.
Napi::Value CreateConnectionWrapper(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Path string expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    // An embedded NUL truncates the argument at the C boundary, and a
    // truncated prefix can be an option that consumes the next argv as its
    // value — which is how "--path" gets smuggled past the check below. See
    // open_raw for the measured case.
    if (path.find('\0') != std::string::npos) {
        Napi::TypeError::New(env, "Data directory cannot contain a NUL byte")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::vector<std::string> settings;
    if (info.Length() > 1 && !info[1].IsUndefined() && !info[1].IsNull()) {
        if (!info[1].IsArray()) {
            Napi::TypeError::New(env, "Connection settings must be an array of strings")
                .ThrowAsJavaScriptException();
            return env.Null();
        }
        Napi::Array arr = info[1].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); i++) {
            Napi::Value v = arr.Get(i);
            if (!v.IsString()) {
                Napi::TypeError::New(env, "Connection settings must be an array of strings")
                    .ThrowAsJavaScriptException();
                return env.Null();
            }
            std::string arg = v.As<Napi::String>().Utf8Value();
            // Checked before the --path test, not after: an embedded NUL is
            // exactly how an argument evades that test and still reaches the
            // engine as "--path".
            if (arg.find('\0') != std::string::npos) {
                Napi::TypeError::New(env, "Connection settings cannot contain a NUL byte; it "
                                          "would truncate the argument and let the next one "
                                          "become its value")
                    .ThrowAsJavaScriptException();
                return env.Null();
            }
            // The data directory is the registry key, and the registry is what
            // enforces one bound path per process. A setting that moved the
            // path would connect somewhere the registry does not know about,
            // so the engine and the registry would disagree about what is
            // bound — refuse it here rather than discover it later.
            if (arg == "--path" || arg.rfind("--path=", 0) == 0) {
                Napi::TypeError::New(env, "Connection settings cannot set --path; pass the data "
                                          "directory as the first argument")
                    .ThrowAsJavaScriptException();
                return env.Null();
            }
            settings.push_back(std::move(arg));
        }
    }

    char *error_message = nullptr;
    ChdbConnection conn = CreateConnectionWithArgs(path.c_str(), settings, &error_message);

    if (!conn) {
        std::string msg = error_message ? error_message : "Failed to create connection";
        if (error_message) free(error_message);
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return env.Null();
    }

    {
        std::lock_guard<std::mutex> lock(g_reg_mu);
        g_conn_owner[static_cast<chdb_connection *>(conn)] = env;
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

struct AbiArrayStream {
  int (*get_schema)(AbiArrayStream *, AbiSchema *);
  int (*get_next)(AbiArrayStream *, AbiArray *);
  const char * (*get_last_error)(AbiArrayStream *);
  void (*release)(AbiArrayStream *);
  void * private_data;
};

struct DirectArrowColumn {
  std::string name;
  std::string format;
  bool nullable = false;
  std::string dictionaryFormat;
};
struct DirectArrowDictionary {
  int64_t length = 0;
  int64_t nullCount = 0;
  std::vector<std::vector<uint8_t>> buffers;
};
struct DirectArrowBatch {
  int64_t length = 0;
  // Each column has validity, values, and (for Utf8) offsets/data buffers.
  std::vector<std::vector<std::vector<uint8_t>>> columns;
  std::vector<int64_t> nullCounts;
  std::vector<DirectArrowDictionary> dictionaries;
};

// Copy while the C Data array is alive. Never retain its pointers in a JS
// Buffer after invoking release(); external ArrayBuffers require a separate
// ownership bridge and are not implied by this direct (non-IPC) path.
static bool copyDirectArrowBuffer(const void * ptr, size_t size,
                                  std::vector<uint8_t> & out, std::string & error) {
  constexpr size_t maxBuffer = 512ULL * 1024 * 1024;
  if (size > maxBuffer || (size && !ptr)) {
    error = "Arrow buffer is missing or exceeds the 512 MiB per-buffer limit";
    return false;
  }
  if (size) {
    const auto * bytes = static_cast<const uint8_t *>(ptr);
    out.assign(bytes, bytes + size);
  }
  return true;
}

static void readDirectArrowStream(AbiArrayStream & stream,
                                  std::vector<DirectArrowColumn> & fields,
                                  std::vector<DirectArrowBatch> & batches,
                                  std::string & error) {
  if (!stream.release || !stream.get_schema || !stream.get_next) {
    error = "Invalid Arrow result stream"; return;
  }
  AbiSchema schema{};
  if (stream.get_schema(&stream, &schema) != 0) error = "Arrow get_schema failed";
  else if (!schema.format || std::strcmp(schema.format, "+s") != 0 || schema.n_children < 0)
    error = "Arrow result is not a struct schema";
  if (error.empty()) {
    for (int64_t i = 0; i < schema.n_children; ++i) {
      const AbiSchema * field = schema.children ? schema.children[i] : nullptr;
      if (!field || !field->format || !field->name || field->n_children) {
        error = "Unsupported Arrow result field"; break;
      }
      const std::string format = field->format;
      const bool timestamp = format.size() >= 4 && format[0] == 't' && format[1] == 's' &&
          format[3] == ':' && std::strchr("smun", format[2]);
      int precision = 0, scale = 0, bitWidth = 128;
      const bool decimal = format.rfind("d:", 0) == 0 &&
          std::sscanf(format.c_str(), "d:%d,%d,%d", &precision, &scale, &bitWidth) >= 2 &&
          precision > 0 && (bitWidth == 128 || bitWidth == 256);
      if (format != "c" && format != "C" && format != "s" && format != "S" &&
          format != "i" && format != "I" && format != "l" && format != "L" &&
          format != "f" && format != "g" && format != "b" && format != "u" && format != "z" &&
          !timestamp && !decimal) {
        error = "Unsupported Arrow result format: " + format; break;
      }
      std::string dictionaryFormat;
      if (field->dictionary) {
        if (!field->dictionary->format || field->dictionary->n_children || field->dictionary->dictionary ||
            (format != "i" && format != "I") ||
            (std::strcmp(field->dictionary->format, "u") != 0 &&
             std::strcmp(field->dictionary->format, "z") != 0)) {
          error = "Unsupported Arrow dictionary layout"; break;
        }
        dictionaryFormat = field->dictionary->format;
      }
      fields.push_back({field->name, format, (field->flags & 2) != 0, dictionaryFormat});
    }
  }
  while (error.empty()) {
    AbiArray array{};
    if (stream.get_next(&stream, &array) != 0) {
      error = stream.get_last_error && stream.get_last_error(&stream)
          ? stream.get_last_error(&stream) : "Arrow get_next failed";
    } else if (!array.release) {
      break;
    } else {
      DirectArrowBatch batch;
      batch.length = array.length;
      if (array.length < 0 || array.offset != 0 || array.n_children != static_cast<int64_t>(fields.size()))
        error = "Unsupported Arrow result array layout";
      for (size_t i = 0; error.empty() && i < fields.size(); ++i) {
        const AbiArray * child = array.children ? array.children[i] : nullptr;
        if (!child || child->length != array.length || child->offset != 0 ||
            child->null_count < 0 || child->null_count > child->length || !child->buffers) {
          error = "Unsupported Arrow result child layout"; break;
        }
        const auto & format = fields[i].format;
        const bool variable = format == "u" || format == "z";
        const int needed = variable ? 3 : 2;
        if (child->n_buffers < needed) { error = "Missing Arrow result buffers"; break; }
        std::vector<std::vector<uint8_t>> buffers(needed);
        const size_t validitySize = child->null_count ? static_cast<size_t>((child->length + 7) / 8) : 0;
        if (!copyDirectArrowBuffer(child->buffers[0], validitySize, buffers[0], error)) break;
        size_t valuesSize = 0;
        if (variable) valuesSize = static_cast<size_t>(child->length + 1) * 4;
        else if (format == "b") valuesSize = static_cast<size_t>((child->length + 7) / 8);
        else {
          int decimalPrecision = 0, decimalScale = 0, decimalBitWidth = 128;
          const bool decimal = format.rfind("d:", 0) == 0 &&
              std::sscanf(format.c_str(), "d:%d,%d,%d", &decimalPrecision, &decimalScale,
                          &decimalBitWidth) >= 2;
          const size_t width = decimal ? static_cast<size_t>(decimalBitWidth / 8)
              : format == "c" || format == "C" ? 1
              : format == "s" || format == "S" ? 2
              : format == "i" || format == "I" || format == "f" ? 4 : 8;
          valuesSize = static_cast<size_t>(child->length) * width;
        }
        if (!copyDirectArrowBuffer(child->buffers[1], valuesSize, buffers[1], error)) break;
        if (variable) {
          const auto * offsets = reinterpret_cast<const int32_t *>(child->buffers[1]);
          if (!offsets || offsets[child->length] < 0) {
            error = "Invalid Arrow UTF-8 offsets"; break;
          }
          if (!copyDirectArrowBuffer(child->buffers[2], static_cast<size_t>(offsets[child->length]),
                                     buffers[2], error)) break;
        }
        batch.columns.push_back(std::move(buffers));
        batch.nullCounts.push_back(child->null_count);
        DirectArrowDictionary dictionary;
        if (!fields[i].dictionaryFormat.empty()) {
          const AbiArray * source = child->dictionary;
          if (!source || source->length < 0 || source->offset != 0 || source->n_buffers < 3 ||
              source->null_count < 0 || source->null_count > source->length || !source->buffers) {
            error = "Invalid Arrow dictionary array"; break;
          }
          dictionary.length = source->length;
          dictionary.nullCount = source->null_count;
          dictionary.buffers.resize(3);
          if (!copyDirectArrowBuffer(source->buffers[0], source->null_count ?
              static_cast<size_t>((source->length + 7) / 8) : 0, dictionary.buffers[0], error)) break;
          if (!copyDirectArrowBuffer(source->buffers[1], static_cast<size_t>(source->length + 1) * 4,
                                     dictionary.buffers[1], error)) break;
          const auto * offsets = reinterpret_cast<const int32_t *>(source->buffers[1]);
          if (!offsets || offsets[source->length] < 0) { error = "Invalid Arrow dictionary offsets"; break; }
          if (!copyDirectArrowBuffer(source->buffers[2], static_cast<size_t>(offsets[source->length]),
                                     dictionary.buffers[2], error)) break;
        }
        batch.dictionaries.push_back(std::move(dictionary));
      }
      array.release(&array);
      array.release = nullptr;
      if (error.empty()) batches.push_back(std::move(batch));
    }
    if (!error.empty()) {
      if (array.release) array.release(&array);
      break;
    }
  }
  if (schema.release) schema.release(&schema);
}

static Napi::Object directArrowResultToJs(Napi::Env env,
                                          const std::vector<DirectArrowColumn> & fieldData,
                                          const std::vector<DirectArrowBatch> & batchData) {
  Napi::Array fields = Napi::Array::New(env, fieldData.size());
  for (size_t i = 0; i < fieldData.size(); ++i) {
    Napi::Object field = Napi::Object::New(env);
    field.Set("name", fieldData[i].name);
    field.Set("format", fieldData[i].format);
    field.Set("nullable", Napi::Boolean::New(env, fieldData[i].nullable));
    if (!fieldData[i].dictionaryFormat.empty()) field.Set("dictionaryFormat", fieldData[i].dictionaryFormat);
    fields.Set(i, field);
  }
  Napi::Array batches = Napi::Array::New(env, batchData.size());
  for (size_t i = 0; i < batchData.size(); ++i) {
    Napi::Object batch = Napi::Object::New(env);
    batch.Set("length", Napi::Number::New(env, static_cast<double>(batchData[i].length)));
    Napi::Array columns = Napi::Array::New(env, batchData[i].columns.size());
    for (size_t j = 0; j < batchData[i].columns.size(); ++j) {
      Napi::Object column = Napi::Object::New(env);
      column.Set("nullCount", Napi::Number::New(env, static_cast<double>(batchData[i].nullCounts[j])));
      Napi::Array buffers = Napi::Array::New(env, batchData[i].columns[j].size());
      for (size_t k = 0; k < batchData[i].columns[j].size(); ++k) {
        const auto & data = batchData[i].columns[j][k];
        buffers.Set(k, Napi::Buffer<uint8_t>::Copy(env, data.data(), data.size()));
      }
      column.Set("buffers", buffers);
      if (!fieldData[j].dictionaryFormat.empty()) {
        const auto & source = batchData[i].dictionaries[j];
        Napi::Object dictionary = Napi::Object::New(env);
        dictionary.Set("length", Napi::Number::New(env, static_cast<double>(source.length)));
        dictionary.Set("nullCount", Napi::Number::New(env, static_cast<double>(source.nullCount)));
        Napi::Array dataBuffers = Napi::Array::New(env, source.buffers.size());
        for (size_t k = 0; k < source.buffers.size(); ++k) {
          const auto & data = source.buffers[k];
          dataBuffers.Set(k, Napi::Buffer<uint8_t>::Copy(env, data.data(), data.size()));
        }
        dictionary.Set("buffers", dataBuffers);
        column.Set("dictionary", dictionary);
      }
      columns.Set(j, column);
    }
    batch.Set("columns", columns);
    batches.Set(i, batch);
  }
  Napi::Object out = Napi::Object::New(env);
  out.Set("fields", fields);
  out.Set("batches", batches);
  return out;
}

static bool parseDirectArrowOptions(Napi::Env env, Napi::Value input, chdb_arrow_options & options) {
  options = {0, 0, 1};
  if (input.IsUndefined() || input.IsNull()) return true;
  if (!input.IsObject()) {
    Napi::TypeError::New(env, "Arrow options must be an object").ThrowAsJavaScriptException();
    return false;
  }
  Napi::Object object = input.As<Napi::Object>();
  for (const char * key : {"unsupportedAsBinary", "stringAsString", "lowCardinalityAsDictionary"}) {
    Napi::Value value = object.Get(key);
    if (!value.IsUndefined() && !value.IsBoolean()) {
      Napi::TypeError::New(env, std::string("Arrow option ") + key + " must be boolean").ThrowAsJavaScriptException();
      return false;
    }
  }
  Napi::Value unsupported = object.Get("unsupportedAsBinary");
  Napi::Value stringAsString = object.Get("stringAsString");
  Napi::Value dictionary = object.Get("lowCardinalityAsDictionary");
  if (!unsupported.IsUndefined()) options.unsupported_as_binary = unsupported.As<Napi::Boolean>().Value();
  if (!stringAsString.IsUndefined()) options.string_as_string = stringAsString.As<Napi::Boolean>().Value();
  if (!dictionary.IsUndefined()) options.low_cardinality_as_dictionary = dictionary.As<Napi::Boolean>().Value();
  return true;
}

class QueryArrowWorker : public Napi::AsyncWorker {
public:
  QueryArrowWorker(Napi::Env env, chdb_connection conn, std::string sql, chdb_arrow_options options)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
        conn_(conn), sql_(std::move(sql)), options_(options), guard_(conn) {}
  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    AbiArrayStream stream{};
    chdb_result * result = chdb_query_arrow_n(
        conn_, sql_.data(), sql_.size(), reinterpret_cast<chdb_arrow_stream>(&stream), &options_);
    if (!result) { SetError("chdb_query_arrow_n returned a null result"); return; }
    std::string error;
    if (const char * nativeError = chdb_result_error(result)) error = nativeError;
    if (error.empty()) readDirectArrowStream(stream, fields_, batches_, error);
    if (stream.release) stream.release(&stream);
    chdb_destroy_query_result(result);
    if (!error.empty()) SetError(error);
  }

  void OnOK() override {
    deferred_.Resolve(directArrowResultToJs(Env(), fields_, batches_));
  }
  void OnError(const Napi::Error & e) override { deferred_.Reject(e.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  chdb_connection conn_;
  std::string sql_;
  chdb_arrow_options options_;
  std::vector<DirectArrowColumn> fields_;
  std::vector<DirectArrowBatch> batches_;
  ConnGuard guard_;
};

Napi::Value QueryArrowAsyncWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsExternal() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, SQL").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto * conn = static_cast<chdb_connection *>(info[0].As<Napi::External<void>>().Data());
  if (!conn || !*conn) return rejectedPromise(env, "No active connection available");
  chdb_arrow_options options;
  if (!parseDirectArrowOptions(env, info.Length() >= 3 ? info[2] : env.Undefined(), options)) return env.Undefined();
  auto * worker = new QueryArrowWorker(env, *conn, info[1].As<Napi::String>().Utf8Value(), options);
  worker->Queue();
  return worker->GetPromise();
}

struct DirectArrowStreamState {
  chdb_connection conn;
  chdb_result * handle;
  bool closed = false;
};

static void closeDirectArrowStream(DirectArrowStreamState * state) {
  if (!state || state->closed) return;
  state->closed = true;
  if (state->handle) {
    chdb_stream_cancel_query(state->conn, state->handle);
    chdb_destroy_query_result(state->handle);
    state->handle = nullptr;
  }
}

Napi::Value StartArrowStreamWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsExternal() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, SQL").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto * conn = static_cast<chdb_connection *>(info[0].As<Napi::External<void>>().Data());
  if (!conn || !*conn) {
    Napi::Error::New(env, "No active connection available").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_arrow_options options;
  if (!parseDirectArrowOptions(env, info.Length() >= 3 ? info[2] : env.Undefined(), options)) return env.Undefined();
  const std::string sql = info[1].As<Napi::String>().Utf8Value();
  chdb_result * handle = nullptr;
  if (info.Length() >= 4 && info[3].IsObject()) {
    std::vector<std::string> names, values;
    if (!collectParams(info[3].As<Napi::Object>(), names, values)) {
      Napi::TypeError::New(env, "Arrow stream parameter values must be pre-formatted strings")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const size_t count = names.size();
    std::vector<const char *> cNames(count), cValues(count);
    std::vector<size_t> valueLengths(count);
    for (size_t i = 0; i < count; ++i) {
      cNames[i] = names[i].c_str();
      cValues[i] = values[i].data();
      valueLengths[i] = values[i].size();
    }
    handle = chdb_stream_query_arrow_with_params_n(*conn, sql.data(), sql.size(), &options,
        count ? cNames.data() : nullptr, nullptr,
        count ? cValues.data() : nullptr, count ? valueLengths.data() : nullptr, count);
  } else {
    handle = chdb_stream_query_arrow_n(*conn, sql.data(), sql.size(), &options);
  }
  if (!handle) {
    Napi::Error::New(env, "chdb_stream_query_arrow_n returned a null handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (const char * error = chdb_result_error(handle)) {
    const std::string message = error;
    chdb_destroy_query_result(handle);
    Napi::Error::New(env, message).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto * state = new DirectArrowStreamState{*conn, handle, false};
  return Napi::External<DirectArrowStreamState>::New(env, state, [](Napi::Env, DirectArrowStreamState * s) {
    closeDirectArrowStream(s);
    delete s;
  });
}

class FetchArrowWorker : public Napi::AsyncWorker {
public:
  FetchArrowWorker(Napi::Env env, DirectArrowStreamState * state, Napi::Value handle)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
        state_(state), handleRef_(Napi::Persistent(handle)), guard_(state ? state->conn : nullptr) {}
  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    if (!state_ || state_->closed || !state_->handle) { done_ = true; return; }
    AbiArrayStream batch{};
    const chdb_state status = chdb_stream_fetch_arrow(
        state_->conn, state_->handle, reinterpret_cast<chdb_arrow_stream>(&batch));
    std::string error;
    if (status != CHDBSuccess) error = "chdb_stream_fetch_arrow failed";
    if (error.empty()) readDirectArrowStream(batch, fields_, batches_, error);
    if (batch.release) batch.release(&batch);
    if (!error.empty()) {
      closeDirectArrowStream(state_);
      SetError(error);
      return;
    }
    if (batches_.empty()) {
      done_ = true;
      chdb_destroy_query_result(state_->handle);
      state_->handle = nullptr;
      state_->closed = true;
    }
  }
  void OnOK() override {
    Napi::Object out = directArrowResultToJs(Env(), fields_, batches_);
    out.Set("done", Napi::Boolean::New(Env(), done_));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error & e) override { deferred_.Reject(e.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  DirectArrowStreamState * state_;
  Napi::Reference<Napi::Value> handleRef_;
  bool done_ = false;
  std::vector<DirectArrowColumn> fields_;
  std::vector<DirectArrowBatch> batches_;
  ConnGuard guard_;
};

Napi::Value FetchArrowStreamWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsExternal()) return rejectedPromise(env, "Usage: Arrow stream handle");
  auto * state = info[0].As<Napi::External<DirectArrowStreamState>>().Data();
  auto * worker = new FetchArrowWorker(env, state, info[0]);
  worker->Queue();
  return worker->GetPromise();
}

Napi::Value CancelArrowStreamWrapper(const Napi::CallbackInfo & info) {
  if (info.Length() >= 1 && info[0].IsExternal())
    closeDirectArrowStream(info[0].As<Napi::External<DirectArrowStreamState>>().Data());
  return info.Env().Undefined();
}

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
    chdb_connection * c = get_default_conn(&err, env);
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
  std::vector<std::string> dictionaryFormatStorage;
  // Children are stored contiguously and pointed at via pointer-arrays below.
  std::vector<AbiSchema> childSchemas;
  std::vector<AbiArray> childArrays;
  std::vector<AbiSchema> dictionarySchemas;
  std::vector<AbiArray> dictionaryArrays;
  std::vector<std::vector<const void *>> dictionaryBufferPtrs;
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
struct LiveArrowStream {
  AbiArrayStream stream{};
  std::vector<std::unique_ptr<LiveArrowTable>> batches;
  size_t next = 0;
};
static std::unordered_map<LiveArrowKey, std::unique_ptr<LiveArrowStream>, LiveArrowKeyHash> g_live_arrow_streams;
struct LiveAsyncArrowStream;
struct AsyncArrowLease {
  std::shared_ptr<LiveAsyncArrowStream> state;
  std::unique_ptr<LiveArrowTable> batch;
};
struct AsyncArrowSignal {
  std::shared_ptr<LiveAsyncArrowStream> state;
  AsyncArrowLease * released = nullptr;
};
struct PendingAsyncArrowBatch {
  std::unique_ptr<LiveArrowTable> batch;
  Napi::Promise::Deferred deferred;
};
struct LiveAsyncArrowStream {
  explicit LiveAsyncArrowStream(Napi::Env owner) : env(owner) {}
  Napi::Env env;
  AbiArrayStream stream{};
  std::unique_ptr<LiveArrowTable> schemaBatch;
  std::deque<std::unique_ptr<LiveArrowTable>> queue;
  std::deque<PendingAsyncArrowBatch> waiting;
  std::mutex mu;
  std::condition_variable cv;
  Napi::ThreadSafeFunction releaseTsfn;
  std::weak_ptr<LiveAsyncArrowStream> self;
  size_t outstanding = 0;
  bool ended = false;
  bool cancelled = false;
  bool tsfnReleased = false;
  std::string error;
  ~LiveAsyncArrowStream() { if (releaseTsfn && !tsfnReleased) releaseTsfn.Release(); }
};
static std::unordered_map<LiveArrowKey, std::shared_ptr<LiveAsyncArrowStream>, LiveArrowKeyHash> g_live_arrow_async;
static std::atomic<uint64_t> g_async_arrow_delivered{0};
static std::atomic<uint64_t> g_async_arrow_released{0};
static std::atomic<uint64_t> g_arrow_input_schema_released{0};
static std::mutex g_live_arrow_mu;

static void countedArrowSchemaRelease(AbiSchema * schema) {
  ++g_arrow_input_schema_released;
  schema->release = nullptr;
}

static void cancelAsyncArrowStream(const std::shared_ptr<LiveAsyncArrowStream> & state) {
  if (!state) return;
  std::deque<PendingAsyncArrowBatch> waiting;
  bool releaseTsfn = false;
  {
    std::lock_guard<std::mutex> lock(state->mu);
    state->cancelled = true;
    state->ended = true;
    if (state->error.empty()) state->error = "Arrow reader cancelled";
    state->queue.clear();
    waiting.swap(state->waiting);
    if (state->outstanding == 0 && !state->tsfnReleased) {
      state->tsfnReleased = true;
      releaseTsfn = true;
    }
  }
  state->cv.notify_all();
  if (releaseTsfn) state->releaseTsfn.Release();
  for (auto & pending : waiting)
    pending.deferred.Reject(Napi::Error::New(state->env, "Arrow reader closed").Value());
}

static int liveAsyncArrowGetSchema(AbiArrayStream * stream, AbiSchema * out) {
  auto * live = static_cast<LiveAsyncArrowStream *>(stream->private_data);
  if (!live || !live->schemaBatch) return 1;
  *out = live->schemaBatch->rootSchema;
  out->release = countedArrowSchemaRelease;
  return 0;
}
static const char * liveAsyncArrowGetLastError(AbiArrayStream * stream) {
  auto * live = static_cast<LiveAsyncArrowStream *>(stream->private_data);
  return live && !live->error.empty() ? live->error.c_str() : nullptr;
}
static void liveAsyncArrowRelease(AbiArrayStream * stream) { stream->release = nullptr; }

static void deliverAsyncArrowSignal(Napi::Env env, Napi::Function, AsyncArrowSignal * signal) {
  auto state = signal->state;
  if (signal->released) delete signal->released; // Napi::Reference: main thread only
  const bool released = signal->released != nullptr;
  if (released) ++g_async_arrow_released;
  delete signal;
  std::optional<Napi::Promise::Deferred> ready;
  bool releaseTsfn = false;
  {
    std::lock_guard<std::mutex> lock(state->mu);
    if (released) --state->outstanding;
    if (state->cancelled && state->outstanding == 0 && !state->tsfnReleased) {
      state->tsfnReleased = true;
      releaseTsfn = true;
    }
    if (!state->cancelled && !state->waiting.empty() && state->queue.size() < 2) {
      auto pending = std::move(state->waiting.front());
      state->waiting.pop_front();
      state->queue.push_back(std::move(pending.batch));
      ready = pending.deferred;
    }
  }
  state->cv.notify_all();
  if (releaseTsfn) state->releaseTsfn.Release();
  if (ready) ready->Resolve(env.Undefined());
}

static void liveAsyncArrowArrayRelease(AbiArray * array) {
  auto * lease = static_cast<AsyncArrowLease *>(array->private_data);
  array->release = nullptr;
  array->private_data = nullptr;
  if (!lease) return;
  // C Data release may run on a core worker. Napi::Reference destruction and
  // producer promise resolution must happen on the owning JS isolate instead.
  auto * signal = new AsyncArrowSignal{lease->state, lease};
  napi_status status = lease->state->releaseTsfn.NonBlockingCall(signal, deliverAsyncArrowSignal);
  // During isolate shutdown there is no safe thread on which to drop pinned
  // JS references. Leave the lease for process teardown rather than release it
  // on a core worker. Normal operation never takes this path.
  (void)status;
}

static int liveAsyncArrowGetNext(AbiArrayStream * stream, AbiArray * out) {
  auto * live = static_cast<LiveAsyncArrowStream *>(stream->private_data);
  if (!live) return 1;
  std::unique_lock<std::mutex> lock(live->mu);
  live->cv.wait(lock, [live] { return !live->queue.empty() || live->ended || live->cancelled; });
  if (live->cancelled || !live->error.empty()) return 1;
  if (live->queue.empty()) { *out = {}; return 0; }
  auto batch = std::move(live->queue.front());
  live->queue.pop_front();
  ++live->outstanding;
  lock.unlock();
  // The state is also owned by the registration map and its JS handle. The
  // weak self reference avoids a permanent ownership cycle.
  auto * lease = new AsyncArrowLease{live->self.lock(), std::move(batch)};
  ++g_async_arrow_delivered;
  auto * capacity = new AsyncArrowSignal{lease->state, nullptr};
  (void)live->releaseTsfn.NonBlockingCall(capacity, deliverAsyncArrowSignal);
  *out = lease->batch->rootArray;
  out->release = liveAsyncArrowArrayRelease;
  out->private_data = lease;
  return 0;
}

static int liveArrowGetSchema(AbiArrayStream * stream, AbiSchema * out) {
  auto * live = static_cast<LiveArrowStream *>(stream->private_data);
  if (!live || live->batches.empty()) return 1;
  *out = live->batches.front()->rootSchema;
  out->release = countedArrowSchemaRelease;
  return 0;
}
static int liveArrowGetNext(AbiArrayStream * stream, AbiArray * out) {
  auto * live = static_cast<LiveArrowStream *>(stream->private_data);
  if (!live) return 1;
  if (live->next >= live->batches.size()) {
    *out = {};
    return 0;
  }
  *out = live->batches[live->next++]->rootArray;
  out->release = AbiArrayNoopRelease;
  return 0;
}
static const char * liveArrowGetLastError(AbiArrayStream *) { return nullptr; }
static void liveArrowRelease(AbiArrayStream * stream) { stream->release = nullptr; }

// Unregister BEFORE releasing the JS buffers and C-side structs. Core's Arrow
// registry is process-wide and chdb_close_conn does not remove its entries;
// erasing only our map left dangling pointers and reserved names behind.
static void erase_arrow_tables_for_conn(chdb_connection *conn) {
  std::lock_guard<std::mutex> lock(g_live_arrow_mu);
  for (auto it = g_live_arrow_tables.begin(); it != g_live_arrow_tables.end();) {
    if (it->first.first == conn) {
      chdb_arrow_unregister_table(*conn, it->first.second.c_str());
      it = g_live_arrow_tables.erase(it);
    }
    else ++it;
  }
  for (auto it = g_live_arrow_streams.begin(); it != g_live_arrow_streams.end();) {
    if (it->first.first == conn) {
      chdb_arrow_unregister_table(*conn, it->first.second.c_str());
      it = g_live_arrow_streams.erase(it);
    } else ++it;
  }
  for (auto it = g_live_arrow_async.begin(); it != g_live_arrow_async.end();) {
    if (it->first.first == conn) {
      chdb_arrow_unregister_table(*conn, it->first.second.c_str());
      cancelAsyncArrowStream(it->second);
      it = g_live_arrow_async.erase(it);
    } else ++it;
  }
}

// Drop the entire registry (process teardown backstop).
static void clear_all_arrow_tables() {
  std::lock_guard<std::mutex> lock(g_live_arrow_mu);
  // Only called by atexit. The core registry's static destructor may have
  // already run; normal connection closes unregister before reaching here.
  g_live_arrow_tables.clear();
  g_live_arrow_streams.clear();
  g_live_arrow_async.clear();
}

// Build one caller-owned C Data batch from JS column buffers. Used by both
// chdb_arrow_array_scan and the multi-batch C Stream adapter below.
static std::unique_ptr<LiveArrowTable> makeLiveArrowTable(Napi::Env env, Napi::Array columns) {
  uint32_t ncols = columns.Length();
  if (ncols == 0) {
    Napi::TypeError::New(env, "registerArrowTable: at least one column required").ThrowAsJavaScriptException();
    return nullptr;
  }

  auto live = std::make_unique<LiveArrowTable>();
  live->formatStorage.reserve(ncols);
  live->nameStorage.reserve(ncols);
  live->dictionaryFormatStorage.reserve(ncols);
  live->childSchemas.resize(ncols);
  live->childArrays.resize(ncols);
  live->dictionarySchemas.resize(ncols);
  live->dictionaryArrays.resize(ncols);
  live->dictionaryBufferPtrs.resize(ncols);
  live->childSchemaPtrs.resize(ncols);
  live->childArrayPtrs.resize(ncols);
  live->buffers.bufferPtrs.resize(ncols);

  int64_t rootLength = 0;
  bool rootLengthSet = false;

  for (uint32_t i = 0; i < ncols; i++) {
    Napi::Value colv = columns[i];
    if (!colv.IsObject()) {
      Napi::TypeError::New(env, "Each column must be an object").ThrowAsJavaScriptException();
      return nullptr;
    }
    Napi::Object col = colv.As<Napi::Object>();
    Napi::Value nameV = col.Get("name");
    Napi::Value formatV = col.Get("format");
    Napi::Value lengthV = col.Get("length");
    Napi::Value nullCountV = col.Get("nullCount");
    Napi::Value buffersV = col.Get("buffers");
    if (!nameV.IsString() || !formatV.IsString() || !lengthV.IsNumber() || !buffersV.IsArray()) {
      Napi::TypeError::New(env, "Column needs { name, format, length, buffers }").ThrowAsJavaScriptException();
      return nullptr;
    }
    live->nameStorage.emplace_back(nameV.As<Napi::String>().Utf8Value());
    live->formatStorage.emplace_back(formatV.As<Napi::String>().Utf8Value());
    int64_t length = lengthV.As<Napi::Number>().Int64Value();
    int64_t nullCount = nullCountV.IsNumber() ? nullCountV.As<Napi::Number>().Int64Value() : 0;
    // Reject negatives explicitly: a negative length flows straight into
    // ArrowArray.length, and a negative nullCount mismatches the validity bitmap.
    if (length < 0 || nullCount < 0) {
      Napi::TypeError::New(env, "Column length and nullCount must be non-negative").ThrowAsJavaScriptException();
      return nullptr;
    }
    // A separate flag (not a -1 sentinel) so a column whose length is legitimately
    // any value, including 0, sets the root length on the first column.
    if (!rootLengthSet) {
      rootLength = length;
      rootLengthSet = true;
    } else if (rootLength != length) {
      Napi::TypeError::New(env, "All columns must have the same length").ThrowAsJavaScriptException();
      return nullptr;
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
        return nullptr;
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

    Napi::Value dictionary = col.Get("dictionary");
    if (!dictionary.IsUndefined() && !dictionary.IsNull()) {
      if (!dictionary.IsObject()) {
        Napi::TypeError::New(env, "Arrow dictionary must be an object").ThrowAsJavaScriptException();
        return nullptr;
      }
      Napi::Object dict = dictionary.As<Napi::Object>();
      Napi::Value fmt = dict.Get("format"), count = dict.Get("length"),
          nulls = dict.Get("nullCount"), values = dict.Get("buffers");
      if (!fmt.IsString() || !count.IsNumber() || !nulls.IsNumber() || !values.IsArray()) {
        Napi::TypeError::New(env, "Arrow dictionary needs format, length, nullCount, buffers").ThrowAsJavaScriptException();
        return nullptr;
      }
      const int64_t dictLength = count.As<Napi::Number>().Int64Value();
      const int64_t dictNulls = nulls.As<Napi::Number>().Int64Value();
      if (dictLength < 0 || dictNulls < 0 || dictNulls > dictLength) {
        Napi::TypeError::New(env, "Arrow dictionary length/nullCount invalid").ThrowAsJavaScriptException();
        return nullptr;
      }
      live->dictionaryFormatStorage.emplace_back(fmt.As<Napi::String>().Utf8Value());
      Napi::Array dictBuffers = values.As<Napi::Array>();
      auto & pointers = live->dictionaryBufferPtrs[i];
      pointers.reserve(dictBuffers.Length());
      for (uint32_t j = 0; j < dictBuffers.Length(); ++j) {
        Napi::Value value = dictBuffers[j];
        if (value.IsNull() || value.IsUndefined()) { pointers.push_back(nullptr); continue; }
        if (!value.IsBuffer()) {
          Napi::TypeError::New(env, "Arrow dictionary buffers must be Buffers").ThrowAsJavaScriptException();
          return nullptr;
        }
        pointers.push_back(value.As<Napi::Buffer<uint8_t>>().Data());
        live->buffers.jsRefs.push_back(Napi::Reference<Napi::Value>::New(value, 1));
      }
      AbiSchema & ds = live->dictionarySchemas[i];
      ds = {};
      ds.format = live->dictionaryFormatStorage.back().c_str();
      ds.name = "";
      ds.flags = 2;
      ds.release = AbiSchemaNoopRelease;
      cs.dictionary = &ds;
      AbiArray & da = live->dictionaryArrays[i];
      da = {};
      da.length = dictLength;
      da.null_count = dictNulls;
      da.n_buffers = static_cast<int64_t>(pointers.size());
      da.buffers = pointers.data();
      da.release = AbiArrayNoopRelease;
      ca.dictionary = &da;
    }
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

  return live;
}

// nativeArrowRegisterColumns(conn, tableName, columns)
Napi::Value ArrowRegisterColumnsWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "Usage: connection, tableName, columns[]").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();
  auto live = makeLiveArrowTable(env, info[2].As<Napi::Array>());
  if (!live) return env.Undefined();

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

// A materialized apache-arrow Table may contain several RecordBatches. The
// C Stream callbacks only read prebuilt native descriptors and pinned Buffer
// pointers; no JS callback is invoked from a core query worker thread.
Napi::Value ArrowRegisterBatchesWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "Usage: connection, tableName, batches[]").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();
  Napi::Array batches = info[2].As<Napi::Array>();
  if (!batches.Length()) {
    Napi::TypeError::New(env, "Arrow Table needs at least one batch").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto live = std::make_unique<LiveArrowStream>();
  live->batches.reserve(batches.Length());
  for (uint32_t i = 0; i < batches.Length(); ++i) {
    Napi::Value value = batches[i];
    if (!value.IsArray()) {
      Napi::TypeError::New(env, "Each Arrow batch must contain columns[]").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto batch = makeLiveArrowTable(env, value.As<Napi::Array>());
    if (!batch) return env.Undefined();
    if (!live->batches.empty()) {
      const auto & first = *live->batches.front();
      if (batch->nameStorage != first.nameStorage || batch->formatStorage != first.formatStorage) {
        Napi::TypeError::New(env, "Arrow batch schemas must match").ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }
    live->batches.push_back(std::move(batch));
  }
  live->stream.get_schema = liveArrowGetSchema;
  live->stream.get_next = liveArrowGetNext;
  live->stream.get_last_error = liveArrowGetLastError;
  live->stream.release = liveArrowRelease;
  live->stream.private_data = live.get();
  if (chdb_arrow_scan(*conn, tableName.c_str(), reinterpret_cast<chdb_arrow_stream>(&live->stream)) != CHDBSuccess) {
    Napi::Error::New(env, "chdb_arrow_scan failed for table " + tableName).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  {
    std::lock_guard<std::mutex> lock(g_live_arrow_mu);
    g_live_arrow_streams[LiveArrowKey{conn, tableName}] = std::move(live);
  }
  return env.Undefined();
}

struct AsyncArrowHandle { std::shared_ptr<LiveAsyncArrowStream> state; };

Napi::Value ArrowRegisterReaderWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "Usage: connection, tableName, firstBatchColumns[]").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection * conn = nullptr;
  if (!resolveArrowConn(env, info[0], &conn)) return env.Undefined();
  std::string tableName = info[1].As<Napi::String>().Utf8Value();
  auto schemaBatch = makeLiveArrowTable(env, info[2].As<Napi::Array>());
  auto firstBatch = makeLiveArrowTable(env, info[2].As<Napi::Array>());
  if (!schemaBatch || !firstBatch) return env.Undefined();
  auto state = std::make_shared<LiveAsyncArrowStream>(env);
  state->self = state;
  state->schemaBatch = std::move(schemaBatch);
  state->queue.push_back(std::move(firstBatch));
  state->releaseTsfn = Napi::ThreadSafeFunction::New(env,
      Napi::Function::New(env, [](const Napi::CallbackInfo &) {}), "Arrow batch release", 0, 1);
  state->releaseTsfn.Unref(env);
  state->stream.get_schema = liveAsyncArrowGetSchema;
  state->stream.get_next = liveAsyncArrowGetNext;
  state->stream.get_last_error = liveAsyncArrowGetLastError;
  state->stream.release = liveAsyncArrowRelease;
  state->stream.private_data = state.get();
  if (chdb_arrow_scan(*conn, tableName.c_str(), reinterpret_cast<chdb_arrow_stream>(&state->stream)) != CHDBSuccess) {
    Napi::Error::New(env, "chdb_arrow_scan failed for reader " + tableName).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  {
    std::lock_guard<std::mutex> lock(g_live_arrow_mu);
    g_live_arrow_async[LiveArrowKey{conn, tableName}] = state;
  }
  auto * handle = new AsyncArrowHandle{state};
  return Napi::External<AsyncArrowHandle>::New(env, handle, [](Napi::Env, AsyncArrowHandle * h) {
    cancelAsyncArrowStream(h->state);
    delete h;
  });
}

Napi::Value ArrowPushReaderBatchWrapper(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsExternal() || !info[1].IsArray())
    return rejectedPromise(env, "Usage: readerHandle, batchColumns[]");
  auto state = info[0].As<Napi::External<AsyncArrowHandle>>().Data()->state;
  auto batch = makeLiveArrowTable(env, info[1].As<Napi::Array>());
  if (!batch) return env.Undefined();
  if (batch->nameStorage != state->schemaBatch->nameStorage ||
      batch->formatStorage != state->schemaBatch->formatStorage) {
    Napi::TypeError::New(env, "Arrow reader batch schema changed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto deferred = Napi::Promise::Deferred::New(env);
  {
    std::lock_guard<std::mutex> lock(state->mu);
    if (state->cancelled || state->ended) {
      deferred.Reject(Napi::Error::New(env, "Arrow reader is closed").Value());
    } else if (state->queue.size() < 2) {
      state->queue.push_back(std::move(batch));
      state->cv.notify_all();
      deferred.Resolve(env.Undefined());
    } else if (state->waiting.empty()) {
      state->waiting.push_back({std::move(batch), deferred});
    } else {
      deferred.Reject(Napi::Error::New(env, "Arrow reader producer must await backpressure").Value());
    }
  }
  return deferred.Promise();
}

Napi::Value ArrowFinishReaderWrapper(const Napi::CallbackInfo & info) {
  if (info.Length() < 1 || !info[0].IsExternal()) return info.Env().Undefined();
  auto state = info[0].As<Napi::External<AsyncArrowHandle>>().Data()->state;
  std::deque<PendingAsyncArrowBatch> waiting;
  {
    std::lock_guard<std::mutex> lock(state->mu);
    state->ended = true;
    if (info.Length() > 1 && info[1].IsString()) {
      state->error = info[1].As<Napi::String>().Utf8Value();
      waiting.swap(state->waiting);
    }
  }
  state->cv.notify_all();
  for (auto & pending : waiting)
    pending.deferred.Reject(Napi::Error::New(info.Env(), state->error).Value());
  return info.Env().Undefined();
}

Napi::Value ArrowCancelReaderWrapper(const Napi::CallbackInfo & info) {
  if (info.Length() >= 1 && info[0].IsExternal())
    cancelAsyncArrowStream(info[0].As<Napi::External<AsyncArrowHandle>>().Data()->state);
  return info.Env().Undefined();
}

Napi::Value ArrowLifetimeStatsWrapper(const Napi::CallbackInfo & info) {
  Napi::Object result = Napi::Object::New(info.Env());
  result.Set("delivered", Napi::Number::New(info.Env(), static_cast<double>(g_async_arrow_delivered.load())));
  result.Set("released", Napi::Number::New(info.Env(), static_cast<double>(g_async_arrow_released.load())));
  result.Set("schemaReleased", Napi::Number::New(info.Env(), static_cast<double>(g_arrow_input_schema_released.load())));
  return result;
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
    g_live_arrow_streams.erase(LiveArrowKey{ conn, tableName });
    auto async = g_live_arrow_async.find(LiveArrowKey{conn, tableName});
    if (async != g_live_arrow_async.end()) {
      cancelAsyncArrowStream(async->second);
      g_live_arrow_async.erase(async);
    }
  }
  return env.Undefined();
}

//===--------------------------------------------------------------------===//
// Durable V1 engine ABI: chdb_version, chdb_backup_database_n,
// chdb_restore_database_n, chdb_classify_query_n.
//
// These four are everything `chdb/durable`'s EngineAdapter seam needs from the
// engine (docs/design/durable-control-plane.md), and two contract rules decide
// their shape rather than taste:
//
//   1. The binding never builds management SQL. Backup and restore take an
//      identifier and a path, and core builds the AST and does the quoting —
//      so a database name holding a backtick cannot change what runs.
//   2. The binding never classifies SQL itself. No prefix lists, no regular
//      expressions: chdb_classify_query_n is ClickHouse's own parser answering
//      how many executable statements a text holds and whether every
//      persistent write lands in the database the caller owns. A regex cannot
//      see through `INSERT ... FORMAT` inline data or resolve an unqualified
//      table name against the session's current database.
//
// All three connection-taking calls run on a libuv thread. Backup and restore
// are unbounded — a checkpoint archives a whole database — and classification
// joins them there because the parser runs over the whole statement text,
// inline data included. None of them touch the connection registry, so the
// handle has to outlive the call: the JS adapter serializes its operations and
// refuses to close while one is in flight.
//
// Error messages here never echo the SQL. A mutation carrying a credential is
// refused by the layer above, and a message quoting the statement would put
// the credential in a log — which is the one thing that refusal exists to
// prevent.
//===--------------------------------------------------------------------===//

// BACKUP and RESTORE share everything but which symbol they call and what the
// failure is called.
class DurableArchiveWorker : public Napi::AsyncWorker {
public:
  enum Op { Backup, Restore };

  DurableArchiveWorker(Napi::Env env, chdb_connection conn, Op op, std::string database,
                       std::string filePath)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), conn_(conn), op_(op),
        database_(std::move(database)), filePath_(std::move(filePath)), guard_(conn) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    const char *what = op_ == Backup ? "chdb_backup_database_n" : "chdb_restore_database_n";
    // V1 checkpoints are always full. The ABI accepts an incremental base, but
    // an incremental archive records the *path* of that base, and the path does
    // not exist on the machine that restores it — so no base is ever passed.
    chdb_result *result =
        op_ == Backup
            ? chdb_backup_database_n(conn_, database_.data(), database_.size(), filePath_.data(),
                                     filePath_.size(), nullptr, 0)
            : chdb_restore_database_n(conn_, database_.data(), database_.size(), filePath_.data(),
                                      filePath_.size());
    if (!result) {
      SetError(std::string(what) + " returned a null result");
      return;
    }
    const char *error = chdb_result_error(result);
    if (error) {
      std::string msg = std::string(what) + " failed: " + error;
      chdb_destroy_query_result(result);
      SetError(msg);
      return;
    }
    chdb_destroy_query_result(result);
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  chdb_connection conn_;
  Op op_;
  std::string database_, filePath_;
  ConnGuard guard_;
};

class DurableClassifyWorker : public Napi::AsyncWorker {
public:
  DurableClassifyWorker(Napi::Env env, chdb_connection conn, std::string sql, bool hasTarget,
                        std::string targetDatabase)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), conn_(conn),
        sql_(std::move(sql)), hasTarget_(hasTarget), target_(std::move(targetDatabase)),
        guard_(conn) {
    memset(&analysis_, 0, sizeof(analysis_));
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    chdb_query_analysis_v1 out;
    memset(&out, 0, sizeof(out));
    // Size-versioned struct: a newer engine fills only the fields this build
    // compiled room for.
    out.struct_size = sizeof(out);
    chdb_state state = chdb_classify_query_n(conn_, sql_.data(), sql_.size(),
                                             hasTarget_ ? target_.data() : nullptr,
                                             hasTarget_ ? target_.size() : 0, &out);
    if (state != CHDBSuccess) {
      // The ABI carries no message for this, and the statement must not become
      // one. SQL that does not parse is a *successful* UNKNOWN, so a failure
      // here is about the connection or the struct, never the text.
      SetError("chdb_classify_query_n reported CHDBError: the connection is closed, or this "
               "engine wants a larger chdb_query_analysis_v1 than the addon was built against");
      return;
    }
    analysis_ = out;
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Napi::Object out = Napi::Object::New(env);
    out.Set("statementCount", Napi::Number::New(env, analysis_.statement_count));
    out.Set("queryClass", Napi::Number::New(env, analysis_.query_class));
    // Decoded here rather than in JS so the flag bits are read against the
    // enum from the header this addon compiled against, in one place.
    out.Set("hasSecrets",
            Napi::Boolean::New(env, (analysis_.flags & CHDB_QUERY_HAS_SECRETS) != 0));
    out.Set("writesOnlyTargetDatabase",
            Napi::Boolean::New(env,
                               (analysis_.flags & CHDB_QUERY_WRITES_ONLY_TARGET_DATABASE) != 0));
    out.Set("changesDatabaseLifecycle",
            Napi::Boolean::New(env,
                               (analysis_.flags & CHDB_QUERY_CHANGES_DATABASE_LIFECYCLE) != 0));
    deferred_.Resolve(out);
  }

  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

private:
  Napi::Promise::Deferred deferred_;
  chdb_connection conn_;
  std::string sql_;
  bool hasTarget_;
  std::string target_;
  chdb_query_analysis_v1 analysis_;
  ConnGuard guard_;
};

// The connection argument every durable entry point takes, resolved on the main
// thread (the registry is never touched off-thread).
static bool durableConn(Napi::Env env, Napi::Value handle, chdb_connection *out) {
  if (!handle.IsExternal()) {
    Napi::TypeError::New(env, "Connection handle expected").ThrowAsJavaScriptException();
    return false;
  }
  chdb_connection *inner = static_cast<chdb_connection *>(handle.As<Napi::External<void>>().Data());
  if (!inner || !*inner) return false;
  *out = *inner;
  return true;
}

// Args: (connection, database, filePath). Full backup, always.
Napi::Value DurableBackupAsyncWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, database, filePath").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection conn = nullptr;
  if (!durableConn(env, info[0], &conn)) {
    if (env.IsExceptionPending()) return env.Undefined();
    return rejectedPromise(env, "No active connection available");
  }
  auto *worker = new DurableArchiveWorker(env, conn, DurableArchiveWorker::Backup,
                                          info[1].As<Napi::String>().Utf8Value(),
                                          info[2].As<Napi::String>().Utf8Value());
  worker->Queue();
  return worker->GetPromise();
}

// Args: (connection, database, filePath).
Napi::Value DurableRestoreAsyncWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, database, filePath").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection conn = nullptr;
  if (!durableConn(env, info[0], &conn)) {
    if (env.IsExceptionPending()) return env.Undefined();
    return rejectedPromise(env, "No active connection available");
  }
  auto *worker = new DurableArchiveWorker(env, conn, DurableArchiveWorker::Restore,
                                          info[1].As<Napi::String>().Utf8Value(),
                                          info[2].As<Napi::String>().Utf8Value());
  worker->Queue();
  return worker->GetPromise();
}

// Args: (connection, sql, targetDatabase|null). A null target skips the
// writes-only-target-database judgement, and then the flag is never set.
Napi::Value DurableClassifyAsyncWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsString()) {
    Napi::TypeError::New(env, "Usage: connection, sql, [targetDatabase]")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool hasTarget = info.Length() > 2 && info[2].IsString();
  if (info.Length() > 2 && !hasTarget && !info[2].IsUndefined() && !info[2].IsNull()) {
    Napi::TypeError::New(env, "targetDatabase must be a string, null or undefined")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  chdb_connection conn = nullptr;
  if (!durableConn(env, info[0], &conn)) {
    if (env.IsExceptionPending()) return env.Undefined();
    return rejectedPromise(env, "No active connection available");
  }
  auto *worker = new DurableClassifyWorker(
      env, conn, info[1].As<Napi::String>().Utf8Value(), hasTarget,
      hasTarget ? info[2].As<Napi::String>().Utf8Value() : std::string());
  worker->Queue();
  return worker->GetPromise();
}

// The loaded library's own version, which needs no connection: the durable
// compatibility gate runs before a lease is taken or a scratch directory made,
// so it has to be answerable before any connection exists.
Napi::Value EngineVersionWrapper(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const char *version = chdb_version();
  if (!version) {
    Napi::Error::New(env, "chdb_version() returned NULL").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::String::New(env, version);
}

// Exit teardown, called by index.js from the main thread's process 'exit'
// event: the last point before Node calls C exit(), where every static is still
// alive (shutdown_on_process_exit explains why the atexit backstop is too late).
// index.js has closed its sessions by then. This closes what is left, the
// standalone default connection above all, and then stops the engine, so
// nothing of chDB runs into Node's own teardown.
//
// A connection an async call is still running on (the in-flight count) stays
// open: closing it under the call aborts the engine, and Node joins that libuv
// thread only after this returns. For those, the backstop is registered once
// more. exit() then runs it first: after Node has joined the thread, and before
// the statics that the first registration runs after.
//
// While another environment has the addon loaded (a worker_threads Worker),
// nothing is closed: that thread may be using any connection, its own sessions
// or the shared default, and synchronous calls are not in the in-flight count.
// Node stops it only after this returns, so closing one here freed it under
// the worker's next query. The backstop is registered again instead; by the
// time exit() runs it, Node has stopped and joined every worker.
Napi::Value ExitTeardownWrapper(const Napi::CallbackInfo &info) {
  bool started;
  bool busy = g_live_envs.load() > 1;
  {
    std::lock_guard<std::mutex> lk(g_reg_mu);
    started = g_atexit_registered;
    for (auto it = g_reg.conns.begin(); !busy && it != g_reg.conns.end();) {
      chdb_connection *c = *it;
      if (c && inflight_locked(*c) > 0) {
        busy = true;
        ++it;
        continue;
      }
      if (c) {
        erase_arrow_tables_for_conn(c);
        chdb_close_conn(c);
        g_conn_owner.erase(c);
      }
      if (c == g_reg.defaultConn) g_reg.defaultConn = nullptr;
      it = g_reg.conns.erase(it);
    }
    if (g_reg.conns.empty()) g_reg.boundKey.clear();
  }
  if (started) {
    if (busy)
      std::atexit(shutdown_on_process_exit);
    else
      shutdown_engine_once();
  }
  return info.Env().Undefined();
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

  // Durable V1 engine ABI (see the section above).
  exports.Set("EngineVersion", Napi::Function::New(env, EngineVersionWrapper));
  exports.Set("DurableBackupAsync", Napi::Function::New(env, DurableBackupAsyncWrapper));
  exports.Set("DurableRestoreAsync", Napi::Function::New(env, DurableRestoreAsyncWrapper));
  exports.Set("DurableClassifyAsync", Napi::Function::New(env, DurableClassifyAsyncWrapper));

  // Arrow C Data Interface bindings.
  exports.Set("ArrowRegisterArray", Napi::Function::New(env, ArrowRegisterArrayWrapper));
  exports.Set("ArrowRegisterStream", Napi::Function::New(env, ArrowRegisterStreamWrapper));
  exports.Set("ArrowRegisterColumns", Napi::Function::New(env, ArrowRegisterColumnsWrapper));
  exports.Set("ArrowRegisterBatches", Napi::Function::New(env, ArrowRegisterBatchesWrapper));
  exports.Set("ArrowRegisterReader", Napi::Function::New(env, ArrowRegisterReaderWrapper));
  exports.Set("ArrowPushReaderBatch", Napi::Function::New(env, ArrowPushReaderBatchWrapper));
  exports.Set("ArrowFinishReader", Napi::Function::New(env, ArrowFinishReaderWrapper));
  exports.Set("ArrowCancelReader", Napi::Function::New(env, ArrowCancelReaderWrapper));
  exports.Set("ArrowLifetimeStats", Napi::Function::New(env, ArrowLifetimeStatsWrapper));
  exports.Set("ArrowUnregister", Napi::Function::New(env, ArrowUnregisterWrapper));
  exports.Set("QueryArrowAsync", Napi::Function::New(env, QueryArrowAsyncWrapper));
  exports.Set("StartArrowStream", Napi::Function::New(env, StartArrowStreamWrapper));
  exports.Set("FetchArrowStream", Napi::Function::New(env, FetchArrowStreamWrapper));
  exports.Set("CancelArrowStream", Napi::Function::New(env, CancelArrowStreamWrapper));

  // For index.js's process 'exit' hook.
  exports.Set("ExitTeardown", Napi::Function::New(env, ExitTeardownWrapper));

  // Each isolate closes only its own connections. The process exit hook and
  // atexit backstop handle remaining process-wide connections after workers
  // have stopped, without closing another live isolate's session.
  g_live_envs.fetch_add(1);
  env.AddCleanupHook([owner = static_cast<napi_env>(env)] {
    close_for_env(owner);
    g_live_envs.fetch_sub(1);
  });

  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
