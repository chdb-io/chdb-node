#include <napi.h>
#include "libchdb.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

char *Execute(char *query, char *format) {

    char * argv[] = {(char *)"clickhouse", (char *)"--multiquery", (char *)"--output-format=CSV", (char *)"--query="};
    char dataFormat[100]; 
    char *localQuery;
    // Total 4 = 3 arguments + 1 programm name
    int argc = 4;
    struct local_result *result;

    // Format
    snprintf(dataFormat, sizeof(dataFormat), "--format=%s", format);
    argv[2]=strdup(dataFormat);

    // Query - 10 characters + length of query
    localQuery = (char *) malloc(strlen(query)+10);
    if(localQuery == NULL) {

        printf("Out of memmory\n");
        return NULL;
    }

    sprintf(localQuery, "--query=%s", query);
    argv[3]=strdup(localQuery);
    free(localQuery);

    // Main query and result
    result = query_stable(argc, argv);

    //Free it
    free(argv[2]);
    free(argv[3]);

    return result->buf;
}

char *ExecuteSession(char *query, char *format, char *path) {

    char * argv[] = {(char *)"clickhouse", (char *)"--multiquery", (char *)"--output-format=CSV", (char *)"--query=", (char *)"--path=."};
    char dataFormat[100];
    char dataPath[100];
    char *localQuery;
    // Total 4 = 3 arguments + 1 programm name + 1 path for session
    int argc = 5;
    struct local_result *result;

    // Format
    snprintf(dataFormat, sizeof(dataFormat), "--output-format=%s", format);
    argv[2]=strdup(dataFormat);

    // Query - 10 characters + length of query
    localQuery = (char *) malloc(strlen(query)+10);
    if(localQuery == NULL) {

        printf("Out of memmory\n");
        return NULL;
    }

    sprintf(localQuery, "--query=%s", query);
    argv[3]=strdup(localQuery);
    free(localQuery);

    // Path
    snprintf(dataPath, sizeof(dataPath), "--path=%s", path);
    argv[4]=strdup(dataPath);

    // Main query and result
    result = query_stable(argc, argv);

    //Free it
    free(argv[2]);
    free(argv[3]);
    free(argv[4]);


    if (result == NULL) {
      return NULL;
    } else {
      return result->buf;
    }
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
        Napi::TypeError::New(env, "Out of memory").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::String returnValue = Napi::String::New(env, result);
    free(result);
    return returnValue;
}

Napi::Value SessionWrapped(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString()) {
        Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string query = info[0].As<Napi::String>();
    std::string format = info[1].As<Napi::String>();
    std::string path = info[2].As<Napi::String>();

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

