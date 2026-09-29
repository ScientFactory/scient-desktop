#include "scic_preview.h"
#include <cstdio>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>

int wmain(int argc, wchar_t **argv) {
  if (argc != 2) {
    std::fputs("usage: scic-preview FILE.scic\n", stderr);
    return 2;
  }
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[1], -1,
                                         nullptr, 0, nullptr, nullptr);
  if (!length) return 2;
  std::string path(length, '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[1], -1,
                           path.data(), length, nullptr, nullptr)) return 2;
  char *text = nullptr, *error = nullptr;
  const int result = scic_preview_read(path.c_str(), &text, &error);
  if (result != 0) std::fprintf(stderr, "%s\n", error ? error : "Preview unavailable");
  else std::fputs(text, stdout);
  scic_preview_free(text);
  scic_preview_free(error);
  return result;
}
#else

int main(int argc, char **argv) {
  if (argc != 2) {
    std::fputs("usage: scic-preview FILE.scic\n", stderr);
    return 2;
  }
  char *text = nullptr, *error = nullptr;
  const int result = scic_preview_read(argv[1], &text, &error);
  if (result != 0) std::fprintf(stderr, "%s\n", error ? error : "Preview unavailable");
  else std::fputs(text, stdout);
  scic_preview_free(text);
  scic_preview_free(error);
  return result;
}
#endif
