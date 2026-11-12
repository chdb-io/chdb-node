#pragma once

#include <node_api.h>

char *Query(const char *query, const char *format, char **error_message, napi_env owner);
