#include <napi.h>
#include "libchdb.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

char *Execute(char *query, char *format) {
    const char *base_argv[] = {"clickhouse", "--multiquery", "--output-format=CSV", "--query="};
    char dataFormat[100];
    char *localQuery;
    int argc = 4;
    local_result *result;

    snprintf(dataFormat, sizeof(dataFormat), "--format=%s", format);
    char *argv[] = {
        strdup(base_argv[0]),
        strdup(base_argv[1]),
        strdup(dataFormat),
        NULL
    };

    localQuery = (char *)malloc(strlen(query) + 10);
    if (localQuery == NULL) {
        printf("Out of memory\n");
        for (int i = 0; i < 3; ++i) {
            free(argv[i]);
        }
        return NULL;
    }

    sprintf(localQuery, "--query=%s", query);
    argv[3] = strdup(localQuery);
    free(localQuery);

    if (argv[3] == NULL) {
        printf("Out of memory\n");
        for (int i = 0; i < 3; ++i) {
            free(argv[i]);
        }
        return NULL;
    }

    result = query_stable(argc, argv);

    for (int i = 0; i < 4; ++i) {
        free(argv[i]);
    }

    if (result == NULL) {
        return NULL;
    }

    char *result_buf = strdup(result->buf);
    free_result(result);
    return result_buf;
}

char *ExecuteSession(char *query, char *format, char *path) {
    const char *base_argv[] = {"clickhouse", "--multiquery", "--output-format=CSV", "--query=", "--path=."};
    char dataFormat[100];
    char dataPath[100];
    char *localQuery;
    int argc = 5;
    local_result *result;

    snprintf(dataFormat, sizeof(dataFormat), "--output-format=%s", format);
    snprintf(dataPath, sizeof(dataPath), "--path=%s", path);

    char *argv[] = {
        strdup(base_argv[0]),
        strdup(base_argv[1]),
        strdup(dataFormat),
        NULL,
        strdup(dataPath)
    };

    localQuery = (char *)malloc(strlen(query) + 10);
    if (localQuery == NULL) {
        printf("Out of memory\n");
        for (int i = 0; i < 4; ++i) {
            free(argv[i]);
        }
        return NULL;
    }

    sprintf(localQuery, "--query=%s", query);
    argv[3] = strdup(localQuery);
    free(localQuery);

    if (argv[3] == NULL) {
        printf("Out of memory\n");
        for (int i = 0; i < 4; ++i) {
            free(argv[i]);
        }
        return NULL;
    }

    result = query_stable(argc, argv);

    for (int i = 0; i < 5; ++i) {
        free(argv[i]);
    }

    if (result == NULL) {
        return NULL;
    }

    char *result_buf = strdup(result->buf);
    free_result(result);
    return result_buf;
}

Napi::Value ExecuteWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string query = info[0].As<Napi::String>();
    std::string format = info[1].As<Napi::String>();

    char *result = Execute((char *)query.c_str(), (char *)format.c_str());
    if (result == NULL) {
        Napi::String returnValue = Napi::String::New(env, "");
        return returnValue;
    }

    Napi::String returnValue = Napi::String::New(env, result);
    free(result);
    return returnValue;
}

Napi::Value SessionWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Query expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string query = info[0].As<Napi::String>();
    std::string format = "CSV";
    std::string path = "/tmp/";

    if (info[1].IsString()) {
      format = info[1].As<Napi::String>();
    }

    if (info[2].IsString()) {
      path = info[2].As<Napi::String>();
    }

    char *result = ExecuteSession((char *)query.c_str(), (char *)format.c_str(), (char *)path.c_str());
    if (result == NULL) {
        Napi::String returnValue = Napi::String::New(env, "");
        return returnValue;
        // return env.Null();
    }

    Napi::String returnValue = Napi::String::New(env, result);
    free(result);
    return returnValue;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "Execute"),
                Napi::Function::New(env, ExecuteWrapped));
    exports.Set(Napi::String::New(env, "Session"),
                Napi::Function::New(env, SessionWrapped));
    return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
