#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <atomic>
#include <cstdio>
#include <cwchar>
#include <new>
#include "preview_identity.h"

using GetClassObject = HRESULT(STDAPICALLTYPE *)(REFCLSID, REFIID, void **);
using CanUnloadNow = HRESULT(STDAPICALLTYPE *)();

// Free-threaded test source: a blocked Read stays on the worker, independent of
// whether the smoke executable happens to pump its STA message queue.
class DelayedStream final : public IStream {
  std::atomic<ULONG> refs_{1};
  IUnknown *marshaler_ = nullptr;
 public:
  HANDLE entered = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE resume = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  DelayedStream() { CoCreateFreeThreadedMarshaler(static_cast<IStream *>(this), &marshaler_); }
  bool marshalerReady() const { return marshaler_ != nullptr; }
  ~DelayedStream() {
    if (marshaler_) marshaler_->Release();
    CloseHandle(entered);
    CloseHandle(resume);
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (iid == IID_IUnknown || iid == IID_IStream || iid == IID_ISequentialStream)
      *out = static_cast<IStream *>(this);
    else if (iid == IID_IMarshal && marshaler_)
      return marshaler_->QueryInterface(iid, out);
    if (!*out) return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG count = --refs_;
    if (!count) delete this;
    return count;
  }
  HRESULT STDMETHODCALLTYPE Read(void *, ULONG, ULONG *count) override {
    if (count) *count = 0;
    SetEvent(entered);
    WaitForSingleObject(resume, INFINITE);
    return S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE Write(const void *, ULONG, ULONG *) override { return STG_E_ACCESSDENIED; }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER, DWORD, ULARGE_INTEGER *position) override {
    if (position) position->QuadPart = 0;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return STG_E_ACCESSDENIED; }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream *, ULARGE_INTEGER, ULARGE_INTEGER *, ULARGE_INTEGER *) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Revert() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG *stat, DWORD) override {
    if (!stat) return STG_E_INVALIDPOINTER;
    *stat = {};
    stat->cbSize.QuadPart = 128;
    stat->type = STGTY_STREAM;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IStream **) override { return E_NOTIMPL; }
};

static bool pumpUntil(CanUnloadNow canUnloadNow, DWORD milliseconds) {
  const ULONGLONG deadline = GetTickCount64() + milliseconds;
  while (GetTickCount64() < deadline) {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (canUnloadNow() == S_OK) return true;
    Sleep(10);
  }
  return false;
}

static const char *exerciseDelayedStream(IClassFactory *factory, DelayedStream **pending) {
  IPreviewHandler *handler = nullptr;
  IInitializeWithStream *initialize = nullptr;
  DelayedStream *delayed = nullptr;
  DelayedStream *replacement = nullptr;
  HWND parent = nullptr;
  const char *failure = nullptr;
  RECT bounds{0, 0, 300, 160};
  HWND focused = nullptr;
  HWND editor = nullptr;
  ULONGLONG start = 0;
  MSG message{};
  wchar_t label[80]{};
  if (FAILED(factory->CreateInstance(nullptr, IID_IPreviewHandler,
                                     reinterpret_cast<void **>(&handler))) || !handler)
    return "Cannot create delayed preview handler";
  if (FAILED(handler->QueryInterface(IID_IInitializeWithStream,
                                     reinterpret_cast<void **>(&initialize)))) {
    failure = "No IInitializeWithStream";
    goto done;
  }
  delayed = new (std::nothrow) DelayedStream();
  if (!delayed || !delayed->entered || !delayed->resume || !delayed->marshalerReady()) {
    failure = "Cannot create delayed free-threaded stream";
    goto done;
  }
  parent = CreateWindowExW(0, L"STATIC", L"preview smoke", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                           0, 0, 320, 200, nullptr, nullptr, nullptr, nullptr);
  if (!parent) {
    failure = "Cannot create preview parent window";
    goto done;
  }
  if (FAILED(initialize->Initialize(delayed, STGM_READ)) ||
      FAILED(handler->SetWindow(parent, &bounds))) {
    failure = "Cannot initialize delayed preview";
    goto done;
  }
  SetFocus(nullptr);
  SetLastError(ERROR_INVALID_PARAMETER); // GetFocus NULL must not read this stale value.
  focused = reinterpret_cast<HWND>(1);
  if (handler->QueryFocus(&focused) != S_OK || focused != nullptr) {
    failure = "QueryFocus did not report no focus";
    goto done;
  }
  start = GetTickCount64();
  if (handler->DoPreview() != S_OK || GetTickCount64() - start > 1000) {
    failure = "DoPreview blocked on the delayed stream";
    goto done;
  }
  if (handler->GetWindow(&editor) != S_OK || !editor) {
    failure = "Preview placeholder was not created";
    goto done;
  }
  if (handler->SetFocus() != S_OK || handler->QueryFocus(&focused) != S_OK || focused != editor) {
    failure = "SetFocus did not focus the preview edit control";
    goto done;
  }
  if (WaitForSingleObject(delayed->entered, 3000) != WAIT_OBJECT_0) {
    failure = "Delayed stream was not read on the worker";
    goto done;
  }
  start = GetTickCount64();
  if (handler->Unload() != S_OK || GetTickCount64() - start > 1000) {
    failure = "Unload waited for the blocked Read";
    goto done;
  }
  replacement = new (std::nothrow) DelayedStream();
  if (!replacement || !replacement->marshalerReady() ||
      FAILED(initialize->Initialize(replacement, STGM_READ)) ||
      FAILED(handler->SetWindow(parent, &bounds)) || handler->DoPreview() != S_OK ||
      WaitForSingleObject(replacement->entered, 3000) != WAIT_OBJECT_0) {
    failure = "Cannot start replacement preview";
    goto done;
  }
  SetEvent(delayed->resume);
  Sleep(100);
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  editor = nullptr;
  if (handler->GetWindow(&editor) != S_OK || !editor ||
      !GetWindowTextW(editor, label, 80) ||
      std::wcscmp(label, L"Loading conversation preview...") != 0) {
    failure = "Cancelled preview changed a replacement window";
    goto done;
  }
  handler->Unload();
  initialize->Release();
  initialize = nullptr;
  handler->Release();
  handler = nullptr;
  *pending = replacement;
  replacement = nullptr;
 done:
  if (handler) { handler->Unload(); handler->Release(); }
  if (initialize) initialize->Release();
  if (delayed) {
    SetEvent(delayed->resume);
    delayed->Release();
  }
  if (replacement) {
    SetEvent(replacement->resume);
    replacement->Release();
  }
  if (parent) DestroyWindow(parent);
  return failure;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 2) {
    std::fprintf(stderr, "Pass the preview DLL path\n");
    return 2;
  }
  HMODULE module = LoadLibraryW(argv[1]);
  if (!module) {
    std::fprintf(stderr, "Cannot load preview DLL: %lu\n", GetLastError());
    return 1;
  }
  auto getClassObject = reinterpret_cast<GetClassObject>(
      GetProcAddress(module, "DllGetClassObject"));
  auto canUnloadNow = reinterpret_cast<CanUnloadNow>(
      GetProcAddress(module, "DllCanUnloadNow"));
  auto embeddedClsid = reinterpret_cast<const CLSID *>(
      GetProcAddress(module, "ScientConversationPreviewClsid"));
  constexpr CLSID expectedClsid = SCIENT_SCIC_CLSID_INIT;
  IClassFactory *factory = nullptr;
  IPreviewHandler *handler = nullptr;
  DelayedStream *pending = nullptr;
  const char *failure = nullptr;
  const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(apartment)) {
    std::fprintf(stderr, "Cannot initialize COM apartment\n");
    FreeLibrary(module);
    return 1;
  }
  if (!getClassObject || !canUnloadNow || !embeddedClsid)
    failure = "Missing preview DLL export";
  else if (!IsEqualGUID(*embeddedClsid, expectedClsid))
    failure = "Embedded preview CLSID differs from configured CLSID";
  else if (canUnloadNow() != S_OK)
    failure = "Newly loaded preview DLL cannot unload";
  else if (FAILED(getClassObject(expectedClsid, IID_IClassFactory,
                                 reinterpret_cast<void **>(&factory))) || !factory)
    failure = "Cannot acquire preview class factory";
  else if (canUnloadNow() != S_FALSE)
    failure = "Preview DLL can unload while factory is held";
  else if (FAILED(factory->CreateInstance(nullptr, IID_IPreviewHandler,
                                           reinterpret_cast<void **>(&handler))) || !handler)
    failure = "Cannot create preview handler";
  else if (canUnloadNow() != S_FALSE)
    failure = "Preview DLL can unload while handler is held";
  if (!failure) failure = exerciseDelayedStream(factory, &pending);
  if (factory) factory->Release();
  if (!failure && canUnloadNow() != S_FALSE)
    failure = "Preview DLL can unload while handler is held after factory release";
  if (handler) handler->Release();
  if (!failure && canUnloadNow() != S_FALSE)
    failure = "DLL reported unloadable while the stream Read was blocked";
  if (pending) {
    SetEvent(pending->resume);
    pending->Release();
  }
  if (!failure && !pumpUntil(canUnloadNow, 5000))
    failure = "Preview DLL cannot unload after the worker exits";
  if (failure) std::fprintf(stderr, "%s\n", failure);
  CoUninitialize();
  FreeLibrary(module);
  return failure ? 1 : 0;
}
