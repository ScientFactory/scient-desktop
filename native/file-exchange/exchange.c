/* Scient file exchange: never fall back to an overwrite-capable rename. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/syscall.h>
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#endif
int main(int argc, char **argv) {
  if (argc != 3) return 64;
  int result;
#if defined(__APPLE__)
  result = renamex_np(argv[1], argv[2], RENAME_SWAP);
#elif defined(__linux__)
  result = syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE);
#else
  errno = ENOSYS;
  result = -1;
#endif
  if (result == 0) return 0;
  fprintf(stderr, "%d\n", errno);
  return 1;
}
