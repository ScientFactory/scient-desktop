#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include "scic_preview.h"
#include "preview_identity.h"

// combaseapi.h already declares these entry points with STDAPI linkage.
// Export their undecorated names without redeclaring them as dllexport.
#pragma comment(linker, "/EXPORT:DllGetClassObject")
#pragma comment(linker, "/EXPORT:DllCanUnloadNow")

// The artifact builder checks that installer registration matches this DLL.
extern "C" __declspec(dllexport) const CLSID ScientConversationPreviewClsid = SCIENT_SCIC_CLSID_INIT;
static std::atomic<long> gObjects{0};
static std::atomic<long> gLocks{0};
static std::atomic<long> gWorkers{0};
static std::atomic<WPARAM> gNextTask{0};
static std::mutex gWindowClassMutex;
static long gCompletionWindows = 0;
static constexpr long kMaxWorkers = 4;
static constexpr UINT kPreviewReady = WM_APP + 1;
static constexpr wchar_t kCompletionClass[] = L"ScientConversationPreviewCompletionWindow";

static std::wstring wide(const char *value) {
  if (!value) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, nullptr, 0);
  if (!length) return L"Preview unavailable";
  std::wstring result(length, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, result.data(), length);
  result.pop_back();
  return result;
}

struct Task {
  std::atomic<bool> cancelled{false};
  std::mutex mutex;
  std::wstring display;
  IStream *pendingMarshal = nullptr; // released only by the originating apartment
  HWND target = nullptr;
  WPARAM id = 0;
};

struct StreamContext { IStream *stream; Task *task; };

static long long streamRead(void *opaque, void *buffer, unsigned long length) {
  auto *source = static_cast<StreamContext *>(opaque);
  if (source->task->cancelled) return -1;
  ULONG count = 0;
  try {
    const HRESULT result = source->stream->Read(buffer, length, &count);
    return SUCCEEDED(result) && !source->task->cancelled ? static_cast<long long>(count) : -1;
  } catch (...) { return -1; }
}

static long long streamSkip(void *opaque, long long length) {
  auto *source = static_cast<StreamContext *>(opaque);
  if (source->task->cancelled || length < 0) return -1;
  LARGE_INTEGER move{};
  move.QuadPart = length;
  try {
    const HRESULT result = source->stream->Seek(move, STREAM_SEEK_CUR, nullptr);
    return SUCCEEDED(result) && !source->task->cancelled ? length : -1;
  } catch (...) { return -1; }
}

struct WorkerArgs { std::shared_ptr<Task> task; HMODULE module; };

static DWORD WINAPI runWorker(void *opaque) {
  std::unique_ptr<WorkerArgs> args(static_cast<WorkerArgs *>(opaque));
  const HMODULE module = args->module;
  {
    const auto task = args->task;
    try {
      std::wstring display = L"Preview unavailable";
      const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      if (SUCCEEDED(apartment)) {
        IStream *stream = nullptr;
        try {
          IStream *packet = nullptr;
          {
            std::lock_guard<std::mutex> lock(task->mutex);
            packet = task->pendingMarshal;
            task->pendingMarshal = nullptr;
          }
          // CoGetInterfaceAndReleaseStream consumes the marshal packet on failure too.
          const HRESULT result = packet ? CoGetInterfaceAndReleaseStream(
              packet, IID_IStream, reinterpret_cast<void **>(&stream)) : E_ABORT;
          if (SUCCEEDED(result) && stream && !task->cancelled) {
            STATSTG stat{};
            LARGE_INTEGER start{};
            if (SUCCEEDED(stream->Stat(&stat, STATFLAG_NONAME)) && !task->cancelled &&
                stat.cbSize.QuadPart <= 768ULL * 1024 * 1024 &&
                SUCCEEDED(stream->Seek(start, STREAM_SEEK_SET, nullptr)) && !task->cancelled) {
              char *text = nullptr, *error = nullptr;
              StreamContext context{stream, task.get()};
              const int status = scic_preview_read_stream(&context, stat.cbSize.QuadPart,
                                                          streamRead, streamSkip, &text, &error);
              try {
                display = status ? L"Preview unavailable: " + wide(error) : wide(text);
              } catch (...) {
                scic_preview_free(text);
                scic_preview_free(error);
                throw;
              }
              scic_preview_free(text);
              scic_preview_free(error);
            }
          }
        } catch (...) {
          display.clear();
        }
        if (stream) stream->Release();
        CoUninitialize();
      }
      {
        std::lock_guard<std::mutex> lock(task->mutex);
        if (!task->cancelled) {
          task->display = std::move(display);
          PostMessageW(task->target, kPreviewReady, task->id, 0);
        }
      }
    } catch (...) {
      try {
        std::lock_guard<std::mutex> lock(task->mutex);
        if (!task->cancelled) PostMessageW(task->target, kPreviewReady, task->id, 0);
      } catch (...) {}
    }
  }
  args.reset();
  --gWorkers;
  // The module reference closes the DllCanUnloadNow / thread-exit race.
  FreeLibraryAndExitThread(module, 0);
}

class Handler final : public IPreviewHandler, public IInitializeWithStream,
                      public IOleWindow, public IObjectWithSite {
  std::atomic<ULONG> refs_{1};
  IStream *stream_ = nullptr;
  IUnknown *site_ = nullptr;
  IPreviewHandlerFrame *frame_ = nullptr;
  HWND parent_ = nullptr;
  HWND editor_ = nullptr;
  HWND completion_ = nullptr;
  HMODULE module_ = nullptr;
  HMODULE classModule_ = nullptr;
  RECT rect_{};
  std::shared_ptr<Task> task_;

  static LRESULT CALLBACK completionProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) {
      const auto *create = reinterpret_cast<CREATESTRUCTW *>(lparam);
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
    }
    auto *handler = reinterpret_cast<Handler *>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == kPreviewReady && handler) {
      try {
        const auto task = handler->task_;
        if (task && task->id == wparam && !task->cancelled && handler->editor_) {
          std::wstring display;
          IStream *packet = nullptr;
          {
            std::lock_guard<std::mutex> lock(task->mutex);
            display = task->display;
            packet = task->pendingMarshal;
            task->pendingMarshal = nullptr;
          }
          if (packet) {
            CoReleaseMarshalData(packet);
            packet->Release();
          }
          SetWindowTextW(handler->editor_, display.empty() ? L"Preview unavailable" : display.c_str());
        }
      } catch (...) {
        if (handler->editor_) SetWindowTextW(handler->editor_, L"Preview unavailable");
      }
      return 0;
    }
    if (message == WM_NCDESTROY) SetWindowLongPtrW(window, GWLP_USERDATA, 0);
    return DefWindowProcW(window, message, wparam, lparam);
  }

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
    if (site == site_) return S_OK;
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
    IStream *marshaled = nullptr;
    bool reserved = false;
    try {
      editor_ = CreateWindowExW(0, L"EDIT", L"Loading conversation preview...",
          WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
          rect_.left, rect_.top, rect_.right - rect_.left, rect_.bottom - rect_.top,
          parent_, nullptr, nullptr, nullptr);
      if (!editor_) return HRESULT_FROM_WIN32(GetLastError());
      SendMessageW(editor_, EM_SETLIMITTEXT, 0, 0);
      if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
              reinterpret_cast<LPCWSTR>(&ScientConversationPreviewClsid), &module_)) {
        const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
        Unload();
        return error;
      }
      HRESULT registration = S_OK;
      {
        std::lock_guard<std::mutex> lock(gWindowClassMutex);
        if (!gCompletionWindows) {
          WNDCLASSW windowClass{};
          windowClass.lpfnWndProc = completionProc;
          windowClass.hInstance = module_;
          windowClass.lpszClassName = kCompletionClass;
          if (!RegisterClassW(&windowClass))
            registration = HRESULT_FROM_WIN32(GetLastError());
        }
        if (SUCCEEDED(registration)) {
          ++gCompletionWindows;
          classModule_ = module_;
        }
      }
      if (FAILED(registration)) {
        Unload();
        return registration;
      }
      completion_ = CreateWindowExW(0, kCompletionClass, L"", 0, 0, 0, 0, 0,
                                    HWND_MESSAGE, nullptr, module_, this);
      if (!completion_) {
        const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
        Unload();
        return error;
      }
      if (gWorkers.fetch_add(1) >= kMaxWorkers) {
        --gWorkers;
        SetWindowTextW(editor_, L"Preview unavailable: too many previews are still loading");
        return S_OK;
      }
      reserved = true;
      const HRESULT marshaling = CoMarshalInterThreadInterfaceInStream(IID_IStream, stream_, &marshaled);
      if (FAILED(marshaling)) {
        if (marshaled) {
          CoReleaseMarshalData(marshaled);
          marshaled->Release();
        }
        --gWorkers;
        Unload();
        return marshaling;
      }
      task_ = std::make_shared<Task>();
      task_->target = completion_;
      task_->id = ++gNextTask;
      task_->pendingMarshal = marshaled;
      marshaled = nullptr;
      auto args = std::make_unique<WorkerArgs>(WorkerArgs{task_, module_});
      const HANDLE thread = CreateThread(nullptr, 0, runWorker, args.get(), 0, nullptr);
      if (!thread) {
        const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
        --gWorkers;
        Unload();
        return error;
      }
      args.release();
      module_ = nullptr; // worker owns the DLL reference now
      CloseHandle(thread);
      return S_OK;
    } catch (...) {
      if (marshaled) {
        CoReleaseMarshalData(marshaled);
        marshaled->Release();
      }
      if (reserved) --gWorkers;
      Unload();
      return E_OUTOFMEMORY;
    }
  }
  HRESULT STDMETHODCALLTYPE Unload() override {
    IStream *packet = nullptr;
    if (task_) {
      std::lock_guard<std::mutex> lock(task_->mutex);
      task_->cancelled = true;
      task_->target = nullptr;
      packet = task_->pendingMarshal;
      task_->pendingMarshal = nullptr;
    }
    if (packet) {
      CoReleaseMarshalData(packet);
      packet->Release();
    }
    task_.reset();
    if (completion_) {
      MSG message{};
      while (PeekMessageW(&message, completion_, kPreviewReady, kPreviewReady, PM_REMOVE)) {}
      DestroyWindow(completion_);
    }
    completion_ = nullptr;
    if (classModule_) {
      std::lock_guard<std::mutex> lock(gWindowClassMutex);
      if (!--gCompletionWindows) UnregisterClassW(kCompletionClass, classModule_);
      classModule_ = nullptr;
    }
    if (module_) {
      FreeLibrary(module_);
      module_ = nullptr;
    }
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
    // A NULL previous focus is valid. Verify the resulting focus instead.
    return ::GetFocus() == editor_ ? S_OK : E_FAIL;
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
    if (!out) return E_POINTER;
    *out = nullptr;
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

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, LPVOID *out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (clsid != ScientConversationPreviewClsid) return CLASS_E_CLASSNOTAVAILABLE;
  Factory *factory = new (std::nothrow) Factory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT result = factory->QueryInterface(iid, out);
  factory->Release();
  return result;
}

STDAPI DllCanUnloadNow() {
  return gObjects == 0 && gLocks == 0 && gWorkers == 0 ? S_OK : S_FALSE;
}
