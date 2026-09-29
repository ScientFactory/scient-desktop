#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <atomic>
#include <new>
#include <string>
#include "scic_preview.h"
#include "preview_identity.h"

// Exporting the value keeps the channel-specific GUID in the PE image so the
// artifact builder can prove that installer registration matches this DLL.
extern "C" __declspec(dllexport) const CLSID ScientConversationPreviewClsid = SCIENT_SCIC_CLSID_INIT;
static std::atomic<long> gObjects{0};
static std::atomic<long> gLocks{0};

static std::wstring wide(const char *value) {
  if (!value) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, nullptr, 0);
  if (!length) return L"Preview unavailable";
  std::wstring result(length, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, result.data(), length);
  result.pop_back();
  return result;
}

static long long streamRead(void *context, void *buffer, unsigned long length) {
  ULONG count = 0;
  const HRESULT result = static_cast<IStream *>(context)->Read(buffer, length, &count);
  return SUCCEEDED(result) ? static_cast<long long>(count) : -1;
}

static long long streamSkip(void *context, long long length) {
  if (length < 0) return 0;
  LARGE_INTEGER move{};
  move.QuadPart = length;
  return SUCCEEDED(static_cast<IStream *>(context)->Seek(move, STREAM_SEEK_CUR, nullptr)) ? length : 0;
}

class Handler final : public IPreviewHandler, public IInitializeWithStream,
                      public IOleWindow, public IObjectWithSite {
  std::atomic<ULONG> refs_{1};
  IStream *stream_ = nullptr;
  IUnknown *site_ = nullptr;
  IPreviewHandlerFrame *frame_ = nullptr;
  HWND parent_ = nullptr;
  HWND editor_ = nullptr;
  RECT rect_{};

 public:
  Handler() { ++gObjects; }
  ~Handler() { Unload(); --gObjects; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (iid == IID_IUnknown || iid == IID_IPreviewHandler)
      *out = static_cast<IPreviewHandler *>(this);
    else if (iid == IID_IInitializeWithStream)
      *out = static_cast<IInitializeWithStream *>(this);
    else if (iid == IID_IOleWindow)
      *out = static_cast<IOleWindow *>(this);
    else if (iid == IID_IObjectWithSite)
      *out = static_cast<IObjectWithSite *>(this);
    if (!*out) return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG value = --refs_;
    if (!value) delete this;
    return value;
  }
  HRESULT STDMETHODCALLTYPE Initialize(IStream *stream, DWORD mode) override {
    if (!stream || stream_) return E_INVALIDARG;
    if ((mode & STGM_READWRITE) == STGM_READWRITE || (mode & STGM_WRITE) == STGM_WRITE)
      return STG_E_ACCESSDENIED;
    stream_ = stream;
    stream_->AddRef();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetSite(IUnknown *site) override {
    if (frame_) frame_->Release();
    frame_ = nullptr;
    if (site_) site_->Release();
    site_ = site;
    if (site_) {
      site_->AddRef();
      site_->QueryInterface(IID_IPreviewHandlerFrame, reinterpret_cast<void **>(&frame_));
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetSite(REFIID iid, void **out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    return site_ ? site_->QueryInterface(iid, out) : E_FAIL;
  }
  HRESULT STDMETHODCALLTYPE SetWindow(HWND parent, const RECT *rect) override {
    if (!parent || !rect) return E_INVALIDARG;
    parent_ = parent;
    if (editor_) ::SetParent(editor_, parent);
    return SetRect(rect);
  }
  HRESULT STDMETHODCALLTYPE SetRect(const RECT *rect) override {
    if (!rect) return E_INVALIDARG;
    rect_ = *rect;
    if (editor_) MoveWindow(editor_, rect_.left, rect_.top,
                            rect_.right - rect_.left, rect_.bottom - rect_.top, TRUE);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE DoPreview() override {
    if (!parent_ || !stream_) return E_FAIL;
    if (editor_) return S_OK;
    STATSTG stat{};
    if (FAILED(stream_->Stat(&stat, STATFLAG_NONAME)) ||
        stat.cbSize.QuadPart > 768ULL * 1024 * 1024) return E_FAIL;
    LARGE_INTEGER start{};
    if (FAILED(stream_->Seek(start, STREAM_SEEK_SET, nullptr))) return E_FAIL;
    char *text = nullptr, *error = nullptr;
    const int status = scic_preview_read_stream(stream_, stat.cbSize.QuadPart,
                                               streamRead, streamSkip, &text, &error);
    std::wstring display = status ? L"Preview unavailable: " + wide(error) : wide(text);
    scic_preview_free(text);
    scic_preview_free(error);
    editor_ = CreateWindowExW(0, L"EDIT", display.c_str(),
        WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
        rect_.left, rect_.top, rect_.right - rect_.left, rect_.bottom - rect_.top,
        parent_, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!editor_) return HRESULT_FROM_WIN32(GetLastError());
    SendMessageW(editor_, EM_SETLIMITTEXT, 0, 0);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Unload() override {
    if (editor_) DestroyWindow(editor_);
    editor_ = nullptr;
    if (stream_) stream_->Release();
    stream_ = nullptr;
    SetSite(nullptr);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetFocus() override {
    if (!editor_) return E_FAIL;
    ::SetFocus(editor_);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE QueryFocus(HWND *window) override {
    if (!window) return E_POINTER;
    *window = ::GetFocus();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE TranslateAccelerator(MSG *message) override {
    return frame_ ? frame_->TranslateAccelerator(message) : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE GetWindow(HWND *window) override {
    if (!window) return E_POINTER;
    *window = editor_;
    return editor_ ? S_OK : E_FAIL;
  }
  HRESULT STDMETHODCALLTYPE ContextSensitiveHelp(BOOL) override { return E_NOTIMPL; }
};

class Factory final : public IClassFactory {
  std::atomic<ULONG> refs_{1};
 public:
  Factory() { ++gObjects; }
  ~Factory() { --gObjects; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **out) override {
    if (!out) return E_POINTER;
    *out = (iid == IID_IUnknown || iid == IID_IClassFactory) ? static_cast<IClassFactory *>(this) : nullptr;
    if (!*out) return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG value = --refs_;
    if (!value) delete this;
    return value;
  }
  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID iid, void **out) override {
    if (outer) return CLASS_E_NOAGGREGATION;
    Handler *handler = new (std::nothrow) Handler();
    if (!handler) return E_OUTOFMEMORY;
    const HRESULT result = handler->QueryInterface(iid, out);
    handler->Release();
    return result;
  }
  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
    if (lock) ++gLocks;
    else --gLocks;
    return S_OK;
  }
};

extern "C" __declspec(dllexport) HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID iid, void **out) {
  if (clsid != ScientConversationPreviewClsid) return CLASS_E_CLASSNOTAVAILABLE;
  Factory *factory = new (std::nothrow) Factory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT result = factory->QueryInterface(iid, out);
  factory->Release();
  return result;
}

extern "C" __declspec(dllexport) HRESULT __stdcall DllCanUnloadNow() {
  return gObjects == 0 && gLocks == 0 ? S_OK : S_FALSE;
}
