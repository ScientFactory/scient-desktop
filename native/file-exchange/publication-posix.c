#define _GNU_SOURCE
#include "publication-platform.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sandbox.h>
#include <sys/stdio.h>
#include <copyfile.h>
#include <sys/acl.h>
#include <membership.h>
#include <sys/attr.h>
#include <sys/clonefile.h>
#elif defined(__linux__)
#include <sys/syscall.h>
#include <linux/landlock.h>
#include <sys/prctl.h>
#include <sys/xattr.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#endif

static int private_fd(int fd, Entry *entry);
struct Context { int root, parent, record; };
const char *platform_domain(void) { return "errno"; }
int platform_unsupported(void) { return ENOTSUP; }
int platform_invalid(void) { return EINVAL; }
int platform_changed(void) { return ESTALE; }
int platform_exchange_available(void) {
#if defined(__APPLE__) || defined(__linux__)
  return 1;
#else
  return 0;
#endif
}
int platform_atomic_metadata_available(void) {
  /* Replacement still has no visibility-safe actual-displaced-policy primitive.
   * The separate complete-create primitive does not qualify exchange. */
  return 0;
}
int platform_shared_lease_available(void) { return 1; }
int platform_strict_available(void) {
#ifdef __APPLE__
  return 1;
#else
  /* Linux Landlock grants root-object authority even after root relocation.
   * That is not the advertised current-root-path publication contract. */
  return 0;
#endif
}
const char *platform_containment(void) {
#ifdef __APPLE__
  return "macos-current-path-write-policy";
#elif defined(__linux__)
  return "linux-landlock-root-object";
#else
  return "bound-object";
#endif
}
static void stat_entry(const struct stat *stat, Entry *entry) {
  snprintf(entry->dev, sizeof(entry->dev), "%" PRIuMAX, (uintmax_t)stat->st_dev);
  snprintf(entry->ino, sizeof(entry->ino), "%" PRIuMAX, (uintmax_t)stat->st_ino);
  entry->present = 1;
  entry->type = S_ISREG(stat->st_mode) ? "file" : S_ISDIR(stat->st_mode) ? "directory" :
                S_ISLNK(stat->st_mode) ? "symlink" : "other";
}
static int identify(int fd, Entry *entry) {
  struct stat stat;
  if (fstat(fd, &stat)) return errno;
  stat_entry(&stat, entry);
  return 0;
}
static int inspect(int directory, const char *name, Entry *entry) {
  struct stat stat;
  memset(entry, 0, sizeof(*entry));
  if (fstatat(directory, name, &stat, AT_SYMLINK_NOFOLLOW)) return errno == ENOENT ? 0 : errno;
  stat_entry(&stat, entry);
  return 0;
}
static int walk(int base, const char *relative) {
  size_t length = strlen(relative);
  if (length >= PATH_MAX || relative[0] == '/') { errno = EINVAL; return -1; }
  char components[PATH_MAX];
  memcpy(components, relative, length + 1);
  int current = dup(base);
  if (current < 0) return -1;
  if (!length || !strcmp(relative, ".")) return current;
  char *next = components;
  for (;;) {
    char *separator = strchr(next, '/');
    if (separator) *separator = 0;
    if (!next[0] || !strcmp(next, ".") || !strcmp(next, "..")) {
      close(current); errno = EINVAL; return -1;
    }
    int child = openat(current, next, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int error = errno;
    close(current);
    if (child < 0) { errno = error; return -1; }
    current = child;
    if (!separator) return current;
    next = separator + 1;
  }
}
static int absolute_directory(const char *path) {
  if (path[0] != '/') { errno = EINVAL; return -1; }
  int slash = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (slash < 0) return -1;
  int result = walk(slash, path + 1), error = errno;
  close(slash); errno = error;
  return result;
}
#ifdef __APPLE__
static int clone_volume_available(int fd) {
  struct attrlist attributes = {0};
  attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
  attributes.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;
  struct { uint32_t length; vol_capabilities_attr_t volume; } result = {0};
  if (fgetattrlist(fd, &attributes, &result, sizeof(result), 0) ||
      result.length != sizeof(result)) return 0;
  return (result.volume.valid[VOL_CAPABILITIES_INTERFACES] & VOL_CAP_INT_CLONE) &&
         (result.volume.capabilities[VOL_CAPABILITIES_INTERFACES] & VOL_CAP_INT_CLONE);
}
#endif
int platform_atomic_create_available(const char *root) {
#ifdef __APPLE__
  if (!root) return 0;
  int fd = absolute_directory(root);
  if (fd < 0) return 0;
  int available = clone_volume_available(fd);
  close(fd);
  return available;
#else
  (void)root; return 0;
#endif
}
Context *platform_bind_parent(const char *root, const char *parent, int *error) {
  Context *context = malloc(sizeof(*context));
  if (!context) { *error = ENOMEM; return NULL; }
  context->root = context->parent = context->record = -1;
  context->root = absolute_directory(root);
  if (context->root >= 0) context->parent = walk(context->root, parent);
  if (context->root < 0 || context->parent < 0) {
    *error = errno; platform_close(context); return NULL;
  }
  return context;
}
int platform_parent_binding(Context *context, Entry *root, Entry *parent) {
  int error = identify(context->root, root);
  return error ? error : identify(context->parent, parent);
}
int platform_lock_parent(Context *context, int exclusive) {
  int result;
  int flags = exclusive ? LOCK_EX : LOCK_SH;
#ifdef SCIENT_PUBLICATION_PROBE
  if (getenv("SCIENT_LEASE_PROBE")) { printf("LEASE_WAIT\n"); fflush(stdout); }
  if (getenv("SCIENT_LEASE_TRY")) flags |= LOCK_NB;
#endif
  do { result = flock(context->parent, flags); } while (result && errno == EINTR);
  if (!result) {
    int descriptor_flags = fcntl(context->parent, F_GETFD);
    if (descriptor_flags < 0 || fcntl(context->parent, F_SETFD, descriptor_flags & ~FD_CLOEXEC) < 0) return errno;
  }
  return result ? errno : 0;
}
void platform_unlock_parent(Context *context) { (void)flock(context->parent, LOCK_UN); }
int platform_run_command(int argc, char **argv, int *exit_code, int *signal) {
  (void)argc;
#ifdef SCIENT_PUBLICATION_PROBE
  if (getenv("SCIENT_PUBLICATION_BARRIER_FD3")) {
    int flags = fcntl(3, F_GETFD);
    if (flags < 0 || fcntl(3, F_SETFD, flags & ~FD_CLOEXEC) < 0) return errno;
  }
#endif
  pid_t child = fork();
  if (child < 0) return errno;
  if (!child) {
    int input = open("/dev/null", O_RDONLY);
    if (input < 0 || dup2(input, STDIN_FILENO) < 0) _exit(71);
    if (input != STDIN_FILENO) close(input);
    /* Actual flock descriptors survive exec and holder death until this process exits. */
    execv(argv[0], argv);
    _exit(71);
  }
  int status = 0;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited < 0) return errno;
  if (WIFEXITED(status)) *exit_code = WEXITSTATUS(status);
  if (WIFSIGNALED(status)) *signal = WTERMSIG(status);
  return 0;
}
Context *platform_bind(const char *root, const char *parent, const char *record, int *error) {
  Context *context = malloc(sizeof(*context));
  if (!context) { *error = ENOMEM; return NULL; }
  context->root = context->parent = context->record = -1;
  context->root = absolute_directory(root);
  if (context->root < 0) goto fail;
  context->parent = walk(context->root, parent);
  if (context->parent < 0) goto fail;
  context->record = absolute_directory(record);
  if (context->record < 0) goto fail;
  struct stat root_stat, parent_stat, record_stat;
  if (fstat(context->root, &root_stat) || fstat(context->parent, &parent_stat) ||
      fstat(context->record, &record_stat)) goto fail;
  int private_error = private_fd(context->record, NULL);
  if (private_error) { errno = private_error; goto fail; }
  if (root_stat.st_dev != parent_stat.st_dev || parent_stat.st_dev != record_stat.st_dev) {
    errno = EXDEV; goto fail;
  }
  return context;
fail:
  *error = errno; platform_close(context); return NULL;
}
void platform_close(Context *context) {
  if (context->root >= 0) close(context->root);
  if (context->parent >= 0) close(context->parent);
  if (context->record >= 0) close(context->record);
  free(context);
}
int platform_binding(Context *context, Entry *root, Entry *parent, Entry *record) {
  int error = identify(context->root, root);
  if (!error) error = identify(context->parent, parent);
  if (!error) error = identify(context->record, record);
  return error;
}
static int flush_directory(int fd) { return fsync(fd) ? errno : 0; }
static int private_fd(int fd, Entry *entry) {
  struct stat stat;
  int error = fstat(fd, &stat) ? errno : 0;
  if (!error && (stat.st_uid != geteuid() || (stat.st_mode & 077) != 0)) error = EACCES;
#ifdef __APPLE__
  if (!error) {
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    /* Darwin reports ENOENT for a linked directory with no extended ACL. */
    if (!acl) error = errno == ENOENT && stat.st_nlink > 0 ? 0 : (errno ? errno : EIO);
    else {
      acl_entry_t ace;
      errno = 0;
      int next = acl_get_entry(acl, ACL_FIRST_ENTRY, &ace);
      while (next == 0 && !error) {
        acl_tag_t tag;
        if (acl_get_tag_type(ace, &tag)) error = errno ? errno : EIO;
        else if (tag == ACL_EXTENDED_ALLOW) {
          uuid_t owner;
          acl_permset_mask_t permissions;
          void *principal = acl_get_qualifier(ace);
          if (!principal) error = errno ? errno : EIO;
          else if (acl_get_permset_mask_np(ace, &permissions)) error = errno ? errno : EIO;
          else if (permissions && (mbr_uid_to_uuid(geteuid(), owner) ||
                   memcmp(principal, owner, sizeof(owner)))) error = EACCES;
          if (principal) acl_free(principal);
        } else if (tag == ACL_EXTENDED_DENY) {
          acl_permset_mask_t permissions;
          if (acl_get_permset_mask_np(ace, &permissions)) error = errno ? errno : EIO;
          else if (permissions) error = EACCES;
        } else error = EACCES;
        if (error) break;
        errno = 0;
        next = acl_get_entry(acl, ACL_NEXT_ENTRY, &ace);
      }
      /* Darwin uses -1/EINVAL for the end; every other failure is unknown. */
      if (!error && !(next == -1 && errno == EINVAL)) error = errno ? errno : EIO;
      acl_free(acl);
    }
  }
#elif defined(__linux__)
  if (!error) {
    ssize_t acl = fgetxattr(fd, "system.posix_acl_access", NULL, 0);
    if (acl >= 0) error = EACCES;
    else if (errno != ENODATA && errno != ENOTSUP) error = errno;
  }
#endif
  if (!error && entry) stat_entry(&stat, entry);
  return error;
}
int platform_private_directory(Context *context, const char *name, Entry *entry) {
  int fd = openat(context->parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno;
  int error = private_fd(fd, entry);
  close(fd);
  return error;
}
int platform_mkdir(Context *context, const char *name, int private_directory, Entry *created,
                   Flush *flush, int *applied) {
#ifdef __APPLE__
  if (private_directory) {
    /* This executable is an isolated publication child; CWD never changes in
     * the server or lease holder. Supply an explicit noninheriting empty ACL
     * at birth, not a repair after exposing a directory. */
    int cwd = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (cwd < 0) return errno;
    filesec_t security = filesec_init();
    acl_t acl = acl_init(0);
    acl_flagset_t flags;
    mode_t mode = 0700;
    int error = 0;
    if (!security || !acl) error = errno ? errno : ENOMEM;
    else if (acl_get_flagset_np(acl, &flags) || acl_add_flag_np(flags, ACL_FLAG_NO_INHERIT) ||
             filesec_set_property(security, FILESEC_MODE, &mode) ||
             filesec_set_property(security, FILESEC_ACL, &acl)) error = errno;
    if (!error && fchdir(context->parent)) error = errno;
    if (!error) {
      if (mkdirx_np(name, security)) error = errno;
      else *applied = 1;
    }
    int restore_error = fchdir(cwd) ? errno : 0;
    close(cwd);
    if (acl) acl_free(acl);
    if (security) filesec_free(security);
    if (error || restore_error) return error ? error : restore_error;
  } else
#endif
  if (mkdirat(context->parent, name, private_directory ? 0700 : 0755)) return errno;
  *applied = 1;
  int error = inspect(context->parent, name, created);
  flush->source_directory = flush_directory(context->parent);
  int directory = openat(context->parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) { flush->destination_directory = errno; return error ? error : errno; }
  flush->destination_directory = flush_directory(directory);
  close(directory);
  return error;
}
static int regular_fd(int directory, const char *name, int write_access) {
  int fd = openat(directory, name, (write_access ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat stat;
  int error = fstat(fd, &stat) ? errno : 0;
  if (!error && !S_ISREG(stat.st_mode)) error = EINVAL;
  if (error) { close(fd); errno = error; return -1; }
  return fd;
}
static int copy_metadata(int source, int destination) {
#ifdef __APPLE__
  return fcopyfile(source, destination, NULL, COPYFILE_STAT | COPYFILE_ACL | COPYFILE_XATTR) ? errno : 0;
#elif defined(__linux__)
  struct stat stat;
  if (fstat(source, &stat)) return errno;
  if (fchown(destination, stat.st_uid, stat.st_gid)) return errno;
  ssize_t existing_length = flistxattr(destination, NULL, 0);
  if (existing_length < 0) return errno;
  if (existing_length) {
    char *existing = malloc((size_t)existing_length);
    if (!existing) return ENOMEM;
    ssize_t observed = flistxattr(destination, existing, (size_t)existing_length);
    int cleanup_error = observed < 0 ? errno : observed != existing_length ? ESTALE : 0;
    for (ssize_t offset = 0; !cleanup_error && offset < observed; offset += (ssize_t)strlen(existing + offset) + 1) {
      if (fgetxattr(source, existing + offset, NULL, 0) < 0) {
        if (errno != ENODATA) cleanup_error = errno;
        else if (fremovexattr(destination, existing + offset)) cleanup_error = errno;
      }
    }
    free(existing);
    if (cleanup_error) return cleanup_error;
  }
  ssize_t length = flistxattr(source, NULL, 0);
  if (length < 0) return errno;
  char *names = length ? malloc((size_t)length) : NULL;
  if (length && !names) return ENOMEM;
  int error = 0;
  ssize_t observed = length ? flistxattr(source, names, (size_t)length) : 0;
  if (observed != length) { error = observed < 0 ? errno : ESTALE; goto done; }
  for (ssize_t offset = 0; offset < length; offset += (ssize_t)strlen(names + offset) + 1) {
    const char *name = names + offset;
    ssize_t size = fgetxattr(source, name, NULL, 0);
    if (size < 0) { error = errno; goto done; }
    void *value = malloc(size ? (size_t)size : 1);
    if (!value) { error = ENOMEM; goto done; }
    ssize_t received = fgetxattr(source, name, value, (size_t)size);
    if (received != size) error = received < 0 ? errno : ESTALE;
    else if (fsetxattr(destination, name, value, (size_t)size, 0)) error = errno;
    free(value);
    if (error) goto done;
  }
  if (fchmod(destination, stat.st_mode & 07777)) { error = errno; goto done; }
  struct timespec times[2] = { stat.st_atim, stat.st_mtim };
  if (futimens(destination, times)) error = errno;
done:
  free(names);
  return error;
#else
  (void)source; (void)destination; return ENOTSUP;
#endif
}
static int flush_entry(int directory, const char *name) {
  struct stat stat;
  if (fstatat(directory, name, &stat, AT_SYMLINK_NOFOLLOW)) return errno == ENOENT ? -1 : errno;
  if (!S_ISREG(stat.st_mode)) return -1;
  int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return errno;
  struct stat opened;
  int result = 0;
  if (fstat(fd, &opened)) result = errno;
  else if (!S_ISREG(opened.st_mode) || opened.st_dev != stat.st_dev || opened.st_ino != stat.st_ino)
    result = ESTALE;
  else if (fsync(fd)) result = errno;
  close(fd);
  return result;
}
int platform_operation(Context *context, const char *operation, const char *source,
                       const char *destination, Entry *before, Entry *after_source,
                       Entry *after_destination, Flush *flush, int *applied) {
  if (!strcmp(operation, "exchange")) {
    int original = regular_fd(context->parent, destination, 0);
    if (original < 0) return errno;
    int stage = regular_fd(context->record, source, 1);
    if (stage < 0) { int error = errno; close(original); return error; }
    int error = identify(stage, before);
    struct stat staged = {0};
    if (!error && fstat(stage, &staged)) error = errno;
    /* Preserve the observed file policy before exposing the new bytes. The
     * atomic swap retains the displaced inode for revision checks/recovery;
     * this does not claim atomic inheritance from an independent writer. */
    if (!error) error = copy_metadata(original, stage);
    struct timespec times[2];
#ifdef __APPLE__
    times[0] = staged.st_atimespec; times[1] = staged.st_mtimespec;
#else
    times[0] = staged.st_atim; times[1] = staged.st_mtim;
#endif
    if (!error && futimens(stage, times)) error = errno;
    if (!error && fsync(stage)) error = errno;
    close(original); close(stage);
    if (error) return error;
#if defined(__APPLE__)
    int result = renameatx_np(context->record, source, context->parent, destination, RENAME_SWAP);
#elif defined(__linux__)
    int result = (int)syscall(SYS_renameat2, context->record, source, context->parent, destination, RENAME_EXCHANGE);
#else
    errno = ENOTSUP; int result = -1;
#endif
    if (result) return errno;
    *applied = 1;
    int source_error = inspect(context->record, source, after_source);
    int destination_error = inspect(context->parent, destination, after_destination);
    flush->source_file = flush_entry(context->record, source);
    flush->destination_file = flush_entry(context->parent, destination);
    flush->source_directory = flush_directory(context->record);
    flush->destination_directory = flush_directory(context->parent);
    return source_error ? source_error : destination_error;
  }
  if (!strcmp(operation, "create")) {
#ifdef __APPLE__
    if (!clone_volume_available(context->root) || !clone_volume_available(context->parent))
      return ENOTSUP;
    int input = regular_fd(context->record, source, 0);
    if (input < 0) return errno;
    int error = identify(input, before);
    /* The stage's final new-file mode must already be set in its private carrier.
     * No CLONE_ACL: the kernel inherits the actual target-parent ACL at birth.
     * NOOWNERCOPY uses ordinary creation ownership, not staged ownership. */
    if (!error && fclonefileat(input, context->parent, destination, CLONE_NOOWNERCOPY)) error = errno;
    if (error) { close(input); return error; }
    *applied = 1;
#ifdef SCIENT_PUBLICATION_PROBE
    if (getenv("SCIENT_PUBLICATION_CREATE_BARRIER")) {
      error = platform_probe_barrier("CREATED");
      if (error) { close(input); return error; }
    }
#endif
    flush->source_file = fsync(input) ? errno : 0;
    close(input);
    int source_error = inspect(context->record, source, after_source);
    int destination_error = inspect(context->parent, destination, after_destination);
    flush->destination_file = flush_entry(context->parent, destination);
    flush->source_directory = flush_directory(context->record);
    flush->destination_directory = flush_directory(context->parent);
    return source_error ? source_error : destination_error;
#else
    return ENOTSUP;
#endif
  }
  if (!strcmp(operation, "mkdir"))
    return platform_mkdir(context, source, 0, after_destination, flush, applied);
  if (!strcmp(operation, "rmdir")) {
    int error = inspect(context->record, source, before);
    if (error) return error;
    if (!before->present || strcmp(before->type, "directory")) return EINVAL;
    if (unlinkat(context->record, source, AT_REMOVEDIR)) return errno;
    *applied = 1;
    flush->source_directory = flush_directory(context->record);
    return inspect(context->record, source, after_source);
  }
  int parent_source = !strcmp(operation, "capture") || !strcmp(operation, "metadata");
  int from = parent_source ? context->parent : context->record;
  int to = parent_source ? context->record : context->parent;
  int error = inspect(from, source, before);
  if (error) return error;
  if (!before->present) return ENOENT;
  if (!strcmp(operation, "link") && strcmp(before->type, "file")) return EINVAL;
  if (!strcmp(operation, "metadata")) {
    int input = regular_fd(from, source, 0);
    if (input < 0) return errno;
    int output = regular_fd(to, destination, 1);
    if (output < 0) { error = errno; close(input); return error; }
    *applied = 1; /* A failing metadata copy can still change the private stage. */
    error = copy_metadata(input, output);
    flush->destination_file = fsync(output) ? errno : 0;
    close(input); close(output);
    int source_error = inspect(from, source, after_source);
    int target_error = inspect(to, destination, after_destination);
    return error ? error : source_error ? source_error : target_error;
  }
  int result;
  if (!strcmp(operation, "link")) {
    /* The source name is inside the private bound record; no final-link following. */
    result = linkat(from, source, to, destination, 0);
  } else {
#if defined(__APPLE__)
    result = renameatx_np(from, source, to, destination, RENAME_EXCL);
#elif defined(__linux__)
    result = (int)syscall(SYS_renameat2, from, source, to, destination, RENAME_NOREPLACE);
#else
    errno = ENOSYS; result = -1;
#endif
  }
  if (result) return errno;
  *applied = 1;
  /* These are post-operation observations, not a CAS or a promise against later writers. */
  int source_error = inspect(from, source, after_source);
  int destination_error = inspect(to, destination, after_destination);
  flush->source_file = flush_entry(from, source);
  flush->destination_file = flush_entry(to, destination);
  flush->source_directory = flush_directory(from);
  flush->destination_directory = flush_directory(to);
  return error ? error : source_error ? source_error : destination_error;
}

#ifdef __APPLE__
static int quote_path(char *output, size_t capacity, const char *path) {
  size_t used = 0;
  for (const unsigned char *p = (const unsigned char *)path; *p; ++p) {
    if (*p < 32 || *p == 127) return EINVAL;
    if (*p == '\\' || *p == '"') {
      if (used + 1 >= capacity) return ENAMETOOLONG;
      output[used++] = '\\';
    }
    if (used + 1 >= capacity) return ENAMETOOLONG;
    output[used++] = (char)*p;
  }
  output[used] = 0;
  return 0;
}
static int macos_write_policy(const char *root, const char *record) {
  char root_quoted[PATH_MAX * 2], record_quoted[PATH_MAX * 2], policy[PATH_MAX * 4 + 256];
  int error = quote_path(root_quoted, sizeof(root_quoted), root);
  if (!error) error = quote_path(record_quoted, sizeof(record_quoted), record);
  if (error) return error;
  int count = snprintf(policy, sizeof(policy),
    "(version 1)(allow default)(deny file-write* (require-not (require-any "
    "(subpath \"%s\")(subpath \"%s\"))))", root_quoted, record_quoted);
  if (count < 0 || (size_t)count >= sizeof(policy)) return ENAMETOOLONG;
  char *diagnostic = NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  int result = sandbox_init(policy, 0, &diagnostic);
  if (diagnostic) sandbox_free_error(diagnostic);
#pragma clang diagnostic pop
  return result ? EPERM : 0;
}
#endif
#if defined(__linux__) && defined(LANDLOCK_ACCESS_FS_REFER) && defined(SYS_landlock_create_ruleset)
static int linux_write_policy(Context *context) {
  /* ABI >= 2 is required for cross-directory namespace REFER enforcement. */
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 2) return abi < 0 ? errno : ENOTSUP;
  uint64_t access = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER;
  struct landlock_ruleset_attr attributes = { .handled_access_fs = access };
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attributes, sizeof(attributes), 0);
  if (ruleset < 0) return errno;
  struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = context->root };
  int result = (int)syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  if (!result && context->record >= 0) {
    rule.parent_fd = context->record;
    result = (int)syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  }
  if (!result) result = prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
  if (!result) result = (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
  int error = result ? errno : 0;
  close(ruleset);
  return error;
}
#endif
int platform_policy(Context *context, const char *mode, const char *root, const char *record) {
  (void)context; (void)mode; (void)root; (void)record;
#ifdef __APPLE__
  return macos_write_policy(root, record);
#elif defined(__linux__) && defined(LANDLOCK_ACCESS_FS_REFER) && defined(SYS_landlock_create_ruleset)
  return !strcmp(mode, "strict-current-root") ? linux_write_policy(context) : 0;
#else
  return !strcmp(mode, "strict-current-root") ? ENOTSUP : 0;
#endif
}
#ifdef SCIENT_PUBLICATION_PROBE
int platform_probe_policy(Context *context, const char *mode, const char *root, const char *record) {
  (void)context; (void)mode; (void)root; (void)record;
#ifdef __APPLE__
  return !strcmp(mode, "probe-macos-sandbox") ? macos_write_policy(root, record) : ENOTSUP;
#elif defined(__linux__) && defined(LANDLOCK_ACCESS_FS_REFER) && defined(SYS_landlock_create_ruleset)
  return !strcmp(mode, "probe-linux-landlock") ? linux_write_policy(context) : ENOTSUP;
#else
  return ENOTSUP;
#endif
}
#endif
