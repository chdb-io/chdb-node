#include "LocalResultV2Wrapper.h"

#include "chdb.h"

Napi::FunctionReference LocalResultV2Wrapper::constructor;

Napi::Object LocalResultV2Wrapper::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(
      env, "LocalResultV2Wrapper",
      {
          InstanceMethod("getBuffer", &LocalResultV2Wrapper::GetBuffer),
          InstanceMethod("getLength", &LocalResultV2Wrapper::GetLength),
          InstanceMethod("getElapsed", &LocalResultV2Wrapper::GetElapsed),
          InstanceMethod("getRowsRead", &LocalResultV2Wrapper::GetRowsRead),
          InstanceMethod("getBytesRead", &LocalResultV2Wrapper::GetBytesRead),
          InstanceMethod("getErrorMessage", &LocalResultV2Wrapper::GetErrorMessage),
      });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();
  exports.Set("LocalResultV2Wrapper", func);

  return exports;
}

LocalResultV2Wrapper::LocalResultV2Wrapper(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<LocalResultV2Wrapper>(info) {
  result_ = info[0].As<Napi::External<local_result_v2>>().Data();
}

LocalResultV2Wrapper::~LocalResultV2Wrapper() {
  if (result_ != nullptr) {
    free_result_v2(result_);
  }
}

Napi::Object LocalResultV2Wrapper::NewInstance(
    Napi::Env env, Napi::External<local_result_v2> external) {
  return constructor.New({external});
}

// Accessor Implementations
Napi::Value LocalResultV2Wrapper::GetBuffer(const Napi::CallbackInfo &info) {
  return Napi::Buffer<char>::New(info.Env(), result_->buf, result_->len);
}

Napi::Value LocalResultV2Wrapper::GetLength(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), result_->len);
}

Napi::Value LocalResultV2Wrapper::GetElapsed(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), result_->elapsed);
}

Napi::Value LocalResultV2Wrapper::GetRowsRead(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), result_->rows_read);
}

Napi::Value LocalResultV2Wrapper::GetBytesRead(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), result_->bytes_read);
}

Napi::Value LocalResultV2Wrapper::GetErrorMessage(
    const Napi::CallbackInfo &info) {
  return result_->error_message == nullptr
             ? info.Env().Null()
             : Napi::String::New(info.Env(), result_->error_message);
}
