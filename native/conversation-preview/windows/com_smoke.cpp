#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <cstdio>
#include "preview_identity.h"

using GetClassObject = HRESULT(STDAPICALLTYPE *)(REFCLSID, REFIID, void **);
using CanUnloadNow = HRESULT(STDAPICALLTYPE *)();

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
  const char *failure = nullptr;
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
  if (factory) factory->Release();
  if (!failure && canUnloadNow() != S_FALSE)
    failure = "Preview DLL can unload while handler is held after factory release";
  if (handler) handler->Release();
  if (!failure && canUnloadNow() != S_OK)
    failure = "Preview DLL cannot unload after releasing handler";
  if (failure) std::fprintf(stderr, "%s\n", failure);
  FreeLibrary(module);
  return failure ? 1 : 0;
}
