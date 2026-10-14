/* Scient file exchange: never fall back to an overwrite-capable rename. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stdio.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/syscall.h>
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#endif

#if defined(__APPLE__)
/*
 * Some drivers accept RENAME_SWAP and perform a plain rename instead: FAT32 on
 * macOS 26 replaces the second file with the first and reports success. Those
 * volumes do say they cannot swap, so ask before swapping. Volumes that do not
 * report the capability (Mac OS Extended) are left to refuse the call themselves.
 */
static int volume_refuses_swap(const char *path) {
  struct statfs volume;
  if (statfs(path, &volume) != 0) return -1;
  struct attrlist request;
  memset(&request, 0, sizeof request);
  request.bitmapcount = ATTR_BIT_MAP_COUNT;
  request.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;
  struct {
    u_int32_t length;
    vol_capabilities_attr_t capabilities;
  } __attribute__((aligned(4), packed)) reply;
  if (getattrlist(volume.f_mntonname, &request, &reply, sizeof reply, 0) != 0) return -1;
  u_int32_t valid = reply.capabilities.valid[VOL_CAPABILITIES_INTERFACES];
  u_int32_t set = reply.capabilities.capabilities[VOL_CAPABILITIES_INTERFACES];
  return (valid & VOL_CAP_INT_RENAME_SWAP) && !(set & VOL_CAP_INT_RENAME_SWAP);
}
#endif

static int fail(int error) {
  fprintf(stderr, "%d\n", error);
  return 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("scient-file-exchange/1");
    return 0;
  }
  if (argc != 3) return 64;
  struct stat left, right;
  if (lstat(argv[1], &left) != 0 || lstat(argv[2], &right) != 0) return fail(errno);
  int result;
#if defined(__APPLE__)
  int refuses = volume_refuses_swap(argv[1]);
  if (refuses < 0) return fail(errno);
  if (refuses) return fail(ENOTSUP);
  result = renamex_np(argv[1], argv[2], RENAME_SWAP);
#elif defined(__linux__)
  result = syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE);
#else
  errno = ENOSYS;
  result = -1;
#endif
  if (result != 0) return fail(errno);
  /* A reported swap must have traded the two entries; anything else is not a swap. */
  struct stat now_left, now_right;
  if (lstat(argv[1], &now_left) != 0 || lstat(argv[2], &now_right) != 0) return fail(EIO);
  if (now_left.st_dev != right.st_dev || now_left.st_ino != right.st_ino ||
      now_right.st_dev != left.st_dev || now_right.st_ino != left.st_ino)
    return fail(EIO);
  return 0;
}
