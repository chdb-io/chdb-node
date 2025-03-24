#ifndef LOCAL_RESULT_V2_WRAPPER_H
#define LOCAL_RESULT_V2_WRAPPER_H

#include <napi.h>

#include "chdb.h"

class LocalResultV2Wrapper : public Napi::ObjectWrap<LocalResultV2Wrapper> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  static Napi::Object NewInstance(Napi::Env env,
                                  Napi::External<local_result_v2> external);

  LocalResultV2Wrapper(const Napi::CallbackInfo &info);
  ~LocalResultV2Wrapper();

 private:
  static Napi::FunctionReference constructor;
  local_result_v2 *result_;

  // Accessors
  Napi::Value GetBuffer(const Napi::CallbackInfo &info);
  Napi::Value GetLength(const Napi::CallbackInfo &info);
  Napi::Value GetElapsed(const Napi::CallbackInfo &info);
  Napi::Value GetRowsRead(const Napi::CallbackInfo &info);
  Napi::Value GetBytesRead(const Napi::CallbackInfo &info);
  Napi::Value GetErrorMessage(const Napi::CallbackInfo &info);
};

#endif  // LOCAL_RESULT_V2_WRAPPER_H
