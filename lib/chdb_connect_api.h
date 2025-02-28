#ifndef SRC_CONNECT_API_H_
#define SRC_CONNECT_API_H_

#include <napi.h>
void FreeResultV2(const Napi::CallbackInfo &info);
Napi::Value ConnectChdb(const Napi::CallbackInfo &info);
Napi::Value CloseConn(const Napi::CallbackInfo &info);
Napi::Value QueryConn(const Napi::CallbackInfo &info);

#endif