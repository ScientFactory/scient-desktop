/* Linux-only inquiries use held descriptors; mount paths never grant write authority. */
#include <dirent.h>
#include <ctype.h>
#include <linux/fs.h>
#include <linux/btrfs.h>
#include <linux/btrfs_tree.h>
#include <linux/magic.h>
#include <sys/ioctl.h>
#include <sys/statfs.h>
#include <sys/sysmacros.h>
#ifndef FS_IOC_GETFSUUID
struct fsuuid2 { unsigned char len; unsigned char uuid[16]; };
#define FS_IOC_GETFSUUID _IOR(0x15, 0, struct fsuuid2)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

typedef struct { unsigned int major, minor; char type[64], source[PATH_MAX]; } LinuxMount;
static int linux_mount(int fd, LinuxMount *mount) {
  char path[64], *line = NULL;
  size_t capacity = 0;
  unsigned long held_id = 0;
  snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", fd);
  FILE *info = fopen(path, "re");
  if (!info) return errno;
  while (getline(&line, &capacity, info) >= 0)
    if (sscanf(line, "mnt_id: %lu", &held_id) == 1) break;
  fclose(info);
  if (!held_id) { free(line); return ENOTSUP; }
  FILE *table = fopen("/proc/self/mountinfo", "re");
  if (!table) { free(line); return errno; }
  int found = 0;
  while (getline(&line, &capacity, table) >= 0) {
    unsigned long id;
    unsigned int major_number, minor_number;
    char *separator = strstr(line, " - ");
    if (separator && sscanf(line, "%lu %*u %u:%u", &id, &major_number, &minor_number) == 3 && id == held_id) {
      if (++found != 1 || sscanf(separator + 3, "%63s %4095s", mount->type, mount->source) != 2) { found = 0; break; }
      mount->major = major_number; mount->minor = minor_number;
    }
  }
  int error = ferror(table) ? EIO : found == 1 ? 0 : ENOTSUP;
  fclose(table); free(line);
  return error;
}
static const char *linux_admission(int fd, LinuxMount *mount) {
  struct statfs fs;
  if (fstatfs(fd, &fs) || linux_mount(fd, mount)) return "unsupported-filesystem";
  if (fs.f_type == TMPFS_MAGIC || fs.f_type == RAMFS_MAGIC) return "volatile-filesystem";
  if (!strcmp(mount->type, "nfs") || !strcmp(mount->type, "nfs4") ||
      !strcmp(mount->type, "cifs") || !strcmp(mount->type, "smb3") ||
      !strcmp(mount->type, "smbfs") || !strcmp(mount->type, "9p") ||
      !strcmp(mount->type, "virtiofs") || !strcmp(mount->type, "fuse.sshfs")) return "network-filesystem";
  if ((fs.f_type == EXT4_SUPER_MAGIC && !strcmp(mount->type, "ext4")) ||
      (fs.f_type == XFS_SUPER_MAGIC && !strcmp(mount->type, "xfs")) ||
      (fs.f_type == BTRFS_SUPER_MAGIC && !strcmp(mount->type, "btrfs"))) return NULL;
  return "unsupported-filesystem";
}
static int linux_subvolume(int fd, uint64_t *id) {
  struct statfs fs;
  if (fstatfs(fd, &fs)) return errno;
  *id = 0;
  if (fs.f_type != BTRFS_SUPER_MAGIC) return 0;
  struct btrfs_ioctl_ino_lookup_args lookup = { .objectid = BTRFS_FIRST_FREE_OBJECTID };
  if (ioctl(fd, BTRFS_IOC_INO_LOOKUP, &lookup)) return errno;
  *id = lookup.treeid;
  return *id ? 0 : EIO;
}
static int linux_same_filesystem(int left, int right) {
  LinuxMount mount;
  if (linux_admission(left, &mount) || linux_admission(right, &mount)) return ENOTSUP;
  struct stat a, b;
  uint64_t av, bv;
  if (fstat(left, &a) || fstat(right, &b)) return errno;
  int error = linux_subvolume(left, &av);
  if (!error) error = linux_subvolume(right, &bv);
  return error ? error : a.st_dev != b.st_dev || av != bv ? EXDEV : 0;
}
static int linux_uuid_text(const char *name, char uuid[37]) {
  if (strlen(name) != 36) return EINVAL;
  for (int i = 0; i < 36; ++i) {
    int dash = i == 8 || i == 13 || i == 18 || i == 23;
    if (dash ? name[i] != '-' : !isxdigit((unsigned char)name[i])) return EINVAL;
    uuid[i] = (char)tolower((unsigned char)name[i]);
  }
  uuid[36] = 0;
  return 0;
}
static int linux_uuid(int fd, const LinuxMount *mount, char uuid[37]) {
  struct fsuuid2 value = {0};
  const char *uuid_directory = "/dev/disk/by-uuid";
#ifdef SCIENT_PUBLICATION_PROBE
  const char *probe_directory = getenv("SCIENT_LINUX_UUID_DIRECTORY");
  if (probe_directory) uuid_directory = probe_directory;
  if (probe_directory) errno = ENOTTY;
  if (!probe_directory && !ioctl(fd, FS_IOC_GETFSUUID, &value)) {
#else
  if (!ioctl(fd, FS_IOC_GETFSUUID, &value)) {
#endif
    if (value.len != 16) return ENOTSUP;
    const unsigned char *u = value.uuid;
    snprintf(uuid, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      u[0],u[1],u[2],u[3],u[4],u[5],u[6],u[7],u[8],u[9],u[10],u[11],u[12],u[13],u[14],u[15]);
    return 0;
  }
  if (errno != ENOTTY && errno != EOPNOTSUPP && errno != ENOSYS && errno != EINVAL) return errno;
  unsigned int device_major = mount->major, device_minor = mount->minor;
  struct btrfs_ioctl_fs_info_args btrfs = {0};
  if (!strcmp(mount->type, "btrfs")) {
    char decoded[PATH_MAX];
    size_t written = 0;
    for (size_t i = 0; mount->source[i]; ++i) {
      unsigned int escaped;
      if (mount->source[i] == '\\' && strlen(mount->source + i) >= 4 && sscanf(mount->source + i + 1, "%3o", &escaped) == 1) {
        decoded[written++] = (char)escaped; i += 3;
      } else decoded[written++] = mount->source[i];
    }
    decoded[written] = 0;
    struct stat source;
    if (stat(decoded, &source) || !S_ISBLK(source.st_mode) || ioctl(fd, BTRFS_IOC_FS_INFO, &btrfs)) return ENOTSUP;
    device_major = major(source.st_rdev); device_minor = minor(source.st_rdev);
  }
  DIR *directory = opendir(uuid_directory);
  if (!directory) return errno;
  int found = 0, error = 0;
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (entry->d_name[0] == '.') continue;
    struct stat device;
    if (fstatat(dirfd(directory), entry->d_name, &device, 0)) { error = errno; break; }
    if (!S_ISBLK(device.st_mode) || major(device.st_rdev) != device_major || minor(device.st_rdev) != device_minor) continue;
    if (++found != 1 || linux_uuid_text(entry->d_name, uuid)) { error = ENOTSUP; break; }
  }
  closedir(directory);
  if (!error && found == 1 && !strcmp(mount->type, "btrfs")) {
    unsigned char bytes[16];
    for (int i = 0, position = 0; i < 16; ++i, position += 2) {
      if (position == 8 || position == 13 || position == 18 || position == 23) ++position;
      unsigned int byte;
      if (sscanf(uuid + position, "%2x", &byte) != 1) return ENOTSUP;
      bytes[i] = (unsigned char)byte;
    }
    if (memcmp(bytes, btrfs.fsid, 16)) error = ENOTSUP;
  }
  return error ? error : found == 1 ? 0 : ENOTSUP;
}
