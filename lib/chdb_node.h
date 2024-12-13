#pragma once

#include <napi.h>

char *Query(const char *query, const char *format);
char *QuerySession(const char *query, const char *format, const char *path);

Napi::String QueryWrapper(const Napi::CallbackInfo &info);
Napi::String QuerySessionWrapper(const Napi::CallbackInfo &info);