/* Scient handle-bound publication protocol v1. */
#include "publication-platform.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#elif defined(SCIENT_PUBLICATION_PROBE)
#include <unistd.h>
#endif

#ifdef SCIENT_PUBLICATION_PROBE
int platform_probe_barrier(const char *label) {
  printf("%s\n", label);
  if (fflush(stdout)) return platform_invalid();
  int next;
  if (getenv("SCIENT_PUBLICATION_BARRIER_FD3")) {
    char byte = 0;
#ifdef _WIN32
    next = _read(3, &byte, 1) == 1 ? (unsigned char)byte : EOF;
#else
    next = read(3, &byte, 1) == 1 ? (unsigned char)byte : EOF;
#endif
  } else next = getchar();
  return next == '\n' ? 0 : platform_invalid();
}
#endif
static void entry_json(const Entry *entry) {
  if (!entry->present) { printf("null"); return; }
  printf("{\"dev\":\"%s\",\"ino\":\"%s\",\"type\":\"%s\"}",
         entry->dev, entry->ino, entry->type);
}
static int name_valid(const char *name) {
  return name[0] && strcmp(name, ".") && strcmp(name, "..") && !strchr(name, '/')
#ifdef _WIN32
         && !strchr(name, '\\') && !strchr(name, ':')
#endif
         ;
}
static int matches(const Entry *entry, const char *dev, const char *ino) {
  return entry->present && !strcmp(entry->dev, dev) && !strcmp(entry->ino, ino);
}
typedef struct { Context *context; Entry root, parent; int locked, exclusive; } LeaseParent;
static int compare_parents(const void *left, const void *right) {
  const LeaseParent *a = left, *b = right;
  int device = strcmp(a->parent.dev, b->parent.dev);
  return device ? device : strcmp(a->parent.ino, b->parent.ino);
}
static int sort_parents(const void *left, const void *right) {
  int identity = compare_parents(left, right);
  return identity ? identity : ((const LeaseParent *)right)->exclusive - ((const LeaseParent *)left)->exclusive;
}
static int publication_main(int argc, char **argv);
static int lease_main(int argc, char **argv) {
  if (argc < 10 || (argc - 3) % 7 || (argc - 3) / 7 > 256 ||
      (strcmp(argv[2], "shared") && strcmp(argv[2], "exclusive"))) return 64;
  size_t count = (size_t)(argc - 3) / 7;
  LeaseParent *parents = calloc(count, sizeof(*parents));
  if (!parents) return 71;
  int error = 0;
  for (size_t i = 0; i < count; ++i) {
    char **binding = argv + 3 + i * 7;
    if (strcmp(binding[6], "shared") && strcmp(binding[6], "exclusive")) {
      error = platform_invalid(); goto done;
    }
    parents[i].exclusive = !strcmp(binding[6], "exclusive");
    parents[i].context = platform_bind_parent(binding[0], binding[1], &error);
    if (!parents[i].context) goto done;
    error = platform_parent_binding(parents[i].context, &parents[i].root, &parents[i].parent);
    if (error) goto done;
    if (!matches(&parents[i].root, binding[2], binding[3]) ||
        !matches(&parents[i].parent, binding[4], binding[5])) {
      error = platform_changed(); goto done;
    }
  }
  qsort(parents, count, sizeof(*parents), sort_parents);
  for (size_t i = 0; i < count; ++i) {
    if (i && !compare_parents(&parents[i - 1], &parents[i])) continue;
    error = platform_lock_parent(parents[i].context, parents[i].exclusive);
    if (error) goto done;
    parents[i].locked = 1;
  }
  printf("{\"version\":1,\"lease\":\"acquired\",\"code\":0,\"codeDomain\":\"%s\"}\n", platform_domain());
  if (fflush(stdout)) { error = platform_invalid(); goto done; }
  for (;;) {
    unsigned char header[4];
    size_t received = fread(header, 1, sizeof(header), stdin);
    if (!received && feof(stdin)) break;
    if (received != sizeof(header)) { error = platform_invalid(); break; }
    uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                      ((uint32_t)header[2] << 8) | header[3];
    if (!length) break;
    if (length > 65536) { error = platform_invalid(); break; }
    char *frame = malloc(length);
    if (!frame) { error = platform_invalid(); break; }
    if (fread(frame, 1, length, stdin) != length || frame[length - 1] != 0) {
      free(frame); error = platform_invalid(); break;
    }
    char *command[16] = { argv[0] };
    size_t offset = 0;
    int arguments = 1;
    while (offset < length && arguments < 15) {
      char *end = memchr(frame + offset, 0, length - offset);
      if (!end) break;
      command[arguments++] = frame + offset;
      offset = (size_t)(end - frame) + 1;
    }
    int covered = 0;
    if (arguments == 15 && offset == length && !strcmp(command[1], "--protocol=1")) {
      int parent_covered = 0, record_covered = 0;
      for (size_t i = 0; i < count; ++i) {
        if (!parents[i].exclusive) continue;
        if (matches(&parents[i].root, command[7], command[8]) &&
            matches(&parents[i].parent, command[9], command[10])) parent_covered = 1;
        if (matches(&parents[i].parent, command[11], command[12])) record_covered = 1;
      }
      covered = !strcmp(command[2], "mkdir") ? parent_covered :
        (!strcmp(command[2], "metadata") || !strcmp(command[2], "rmdir")) ? record_covered :
        parent_covered && record_covered;
    }
    if (arguments == 11 && offset == length && !strcmp(command[1], "--directory=1") &&
        (!strcmp(command[2], "private-create") || !strcmp(command[2], "mkdir"))) {
      for (size_t i = 0; i < count; ++i) {
        if (parents[i].exclusive && matches(&parents[i].root, command[6], command[7]) &&
            matches(&parents[i].parent, command[8], command[9])) covered = 1;
      }
    }
    if (!covered) { free(frame); error = platform_invalid(); break; }
    int exit_code = -1, signal = 0;
#ifdef _WIN32
    /* Mutex ownership is thread-bound: no independently alive Windows writer. */
    exit_code = publication_main(arguments, command);
    int spawn_error = fflush(stdout) ? platform_invalid() : 0;
#else
    int spawn_error = platform_run_command(arguments, command, &exit_code, &signal);
#endif
    free(frame);
    /* The result line alone is not retirement. Only this marker follows actual child exit. */
    printf("{\"version\":1,\"commandExit\":%d,\"commandSignal\":%d,\"code\":%d,\"codeDomain\":\"%s\"}\n",
           exit_code, signal, spawn_error, platform_domain());
    if (fflush(stdout)) { error = platform_invalid(); break; }
  }
done:
  if (error)
    printf("{\"version\":1,\"lease\":\"refused\",\"code\":%d,\"codeDomain\":\"%s\"}\n", error, platform_domain());
  for (size_t i = count; i > 0; --i) {
    if (!parents[i - 1].context) continue;
    if (parents[i - 1].locked) platform_unlock_parent(parents[i - 1].context);
    platform_close(parents[i - 1].context);
  }
  free(parents);
  return ferror(stdout) ? 74 : 0;
}
static int directory_main(int argc, char **argv) {
  if (argc != 11 || (strcmp(argv[2], "bind") && strcmp(argv[2], "private-create") &&
      strcmp(argv[2], "mkdir")) || strcmp(argv[3], "strict-current-root")) return 64;
  int error = 0, applied = 0;
  Entry root = {0}, parent = {0}, created = {0};
  Flush flush = {-1, -1, -1, -1};
  int create = strcmp(argv[2], "bind") != 0;
  int private_directory = !strcmp(argv[2], "private-create");
  Context *context = platform_bind_parent(argv[4], argv[5], &error);
  if (!context) goto result;
  error = platform_parent_binding(context, &root, &parent);
  if (error) goto result;
  if (create) {
    if (!name_valid(argv[10])) { error = platform_invalid(); goto result; }
    if (!matches(&root, argv[6], argv[7]) || !matches(&parent, argv[8], argv[9])) {
      error = platform_changed(); goto result;
    }
    if (private_directory) {
      error = platform_private_directory(context, argv[10], &created);
      if (!error) goto recheck;
      /* Only an absent entry authorizes creation. Broad permissions, wrong
       * owners and final links are refused, never repaired in place. */
#ifdef _WIN32
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) goto result;
#else
      if (error != ENOENT) goto result;
#endif
    }
    if (!platform_strict_available()) { error = platform_unsupported(); goto result; }
    error = platform_policy(context, argv[3], argv[4], argv[4]);
    if (error) goto result;
#ifdef SCIENT_PUBLICATION_PROBE
    if (getenv("SCIENT_PUBLICATION_BARRIER")) {
      error = platform_probe_barrier("BOUND");
      if (error) goto result;
    }
#endif
    error = platform_mkdir(context, argv[10], private_directory, &created, &flush, &applied);
    if (error) goto result;
    if (private_directory) {
      error = platform_private_directory(context, argv[10], &created);
      if (error) goto result;
    }
  }
recheck:
  {
    int check_error = 0;
    Context *current = platform_bind_parent(argv[4], argv[5], &check_error);
    Entry checked_root = {0}, checked_parent = {0};
    if (current) {
      check_error = platform_parent_binding(current, &checked_root, &checked_parent);
      platform_close(current);
    }
    if (check_error || !matches(&checked_root, root.dev, root.ino) ||
        !matches(&checked_parent, parent.dev, parent.ino)) error = platform_changed();
  }
result:
  printf("{\"version\":1,\"outcome\":\"%s\",\"code\":%d,\"codeDomain\":\"%s\","
         "\"containment\":\"%s\",\"binding\":{\"root\":", applied ? "applied" : "unchanged",
         error, platform_domain(), platform_containment());
  entry_json(&root); printf(",\"parent\":"); entry_json(&parent);
  printf(",\"record\":null},\"sourceBefore\":null,\"sourceAfter\":null,\"destinationAfter\":");
  entry_json(&created);
  printf(",\"flush\":{\"sourceFile\":-1,\"destinationFile\":-1,\"sourceDirectory\":%d,\"destinationDirectory\":%d}}\n",
         flush.source_directory, flush.destination_directory);
  if (context) platform_close(context);
  return ferror(stdout) ? 74 : 0;
}
static int publication_main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--lease=1")) return lease_main(argc, argv);
  if (argc > 1 && !strcmp(argv[1], "--directory=1")) return directory_main(argc, argv);
  int error = 0, applied = 0;
  Context *context = NULL;
  Entry root = {0}, parent = {0}, record = {0}, before = {0}, from = {0}, to = {0};
  Flush flush = {-1, -1, -1, -1};
  if ((argc == 3 || argc == 4) && !strcmp(argv[1], "--protocol=1") && !strcmp(argv[2], "capabilities")) {
    printf("{\"version\":1,\"strictCurrentRoot\":%s,\"containment\":\"%s\","
           "\"atomicExchange\":%s,\"atomicPublicationMetadata\":%s,\"atomicCreateMetadata\":%s,\"exclusiveMove\":true,"
           "\"exclusiveLink\":true,\"publicationLease\":true,\"sharedPublicationLease\":%s,"
           "\"privateRetentionDirectory\":%s,\"sourceParentMkdir\":%s,\"codeDomain\":\"%s\"}\n",
           platform_strict_available() ? "true" : "false", platform_containment(),
           platform_exchange_available() ? "true" : "false",
           platform_atomic_metadata_available() ? "true" : "false",
           platform_atomic_create_available(argc == 4 ? argv[3] : NULL) ? "true" : "false",
           platform_shared_lease_available() ? "true" : "false",
           platform_strict_available() ? "true" : "false",
           platform_strict_available() ? "true" : "false",
           platform_domain());
    return 0;
  }
  if (argc != 15 || strcmp(argv[1], "--protocol=1")) return 64;
  const char *op = argv[2], *mode = argv[3];
  int binding = !strcmp(op, "bind");
  if (!binding && strcmp(op, "capture") && strcmp(op, "exchange") &&
      strcmp(op, "create") && strcmp(op, "move") && strcmp(op, "restore") && strcmp(op, "link") &&
      strcmp(op, "metadata") && strcmp(op, "mkdir") && strcmp(op, "rmdir")) {
    error = platform_invalid(); goto result;
  }
  if (!strcmp(mode, "strict-current-root") && !platform_strict_available()) {
    error = platform_unsupported(); goto result;
  }
  if (strcmp(mode, "bound-object") && strcmp(mode, "strict-current-root")) {
#ifdef SCIENT_PUBLICATION_PROBE
    if (strcmp(mode, "probe-macos-sandbox") && strcmp(mode, "probe-linux-landlock"))
#endif
    { error = platform_invalid(); goto result; }
  }
  if (!binding && (!name_valid(argv[13]) || !name_valid(argv[14]))) {
    error = platform_invalid(); goto result;
  }
  if (!binding && !strcmp(op, "exchange") &&
      !platform_exchange_available()) {
    error = platform_unsupported(); goto result;
  }
  if (!binding && !strcmp(op, "create") && !platform_atomic_create_available(argv[4])) {
    error = platform_unsupported(); goto result;
  }
  context = platform_bind(argv[4], argv[5], argv[6], &error);
  if (!context) goto result;
  error = platform_binding(context, &root, &parent, &record);
  if (error) goto result;
  if (!binding && (!matches(&root, argv[7], argv[8]) ||
                   !matches(&parent, argv[9], argv[10]) ||
                   !matches(&record, argv[11], argv[12]))) {
    error = platform_changed(); goto result;
  }
#ifdef SCIENT_PUBLICATION_PROBE
  if (!strcmp(mode, "strict-current-root"))
    error = platform_policy(context, mode, argv[4], argv[6]);
  else if (strcmp(mode, "bound-object"))
    error = platform_probe_policy(context, mode, argv[4], argv[6]);
  if (error) goto result;
  if (!binding && getenv("SCIENT_PUBLICATION_BARRIER")) {
    error = platform_probe_barrier("BOUND");
    if (error) goto result;
  }
#endif
#ifndef SCIENT_PUBLICATION_PROBE
  error = platform_policy(context, mode, argv[4], argv[6]);
  if (error) goto result;
#endif
  if (!binding)
    error = platform_operation(context, op, argv[13], argv[14], &before, &from, &to, &flush, &applied);
  if (!error) {
    /* This determines whether a receipt may acknowledge its pathname binding. Native
     * OS enforcement, not this postcheck, protects descendant authority at mutation. */
    int check_error = 0;
    Context *current = platform_bind(argv[4], argv[5], argv[6], &check_error);
    Entry checked_root = {0}, checked_parent = {0}, checked_record = {0};
    if (current) {
      check_error = platform_binding(current, &checked_root, &checked_parent, &checked_record);
      platform_close(current);
    }
    if (check_error || !matches(&checked_root, root.dev, root.ino) ||
        !matches(&checked_parent, parent.dev, parent.ino) ||
        !matches(&checked_record, record.dev, record.ino)) error = platform_changed();
  }
result:
  printf("{\"version\":1,\"outcome\":\"%s\",\"code\":%d,\"codeDomain\":\"%s\","
         "\"containment\":\"%s\",\"binding\":{\"root\":", applied < 0 ? "unknown" :
         applied ? "applied" : "unchanged", error, platform_domain(),
         !strcmp(mode, "bound-object") ? "bound-object" : platform_containment());
  entry_json(&root); printf(",\"parent\":"); entry_json(&parent);
  printf(",\"record\":"); entry_json(&record); printf("},\"sourceBefore\":"); entry_json(&before);
  printf(",\"sourceAfter\":"); entry_json(&from);
  printf(",\"destinationAfter\":"); entry_json(&to);
  printf(",\"flush\":{\"sourceFile\":%d,\"destinationFile\":%d,"
         "\"sourceDirectory\":%d,\"destinationDirectory\":%d}}\n",
         flush.source_file, flush.destination_file, flush.source_directory, flush.destination_directory);
  if (context) platform_close(context);
  /* Protocol errors are data. A successful exit means the complete result was emitted. */
  return ferror(stdout) ? 74 : 0;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **wide) {
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) return 71;
  char **argv = calloc((size_t)argc, sizeof(*argv));
  if (!argv) return 71;
  int allocated = 0, result = 71;
  for (int i = 0; i < argc; ++i) {
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1, NULL, 0, NULL, NULL);
    if (!size || !(argv[i] = malloc((size_t)size))) goto done;
    ++allocated;
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide[i], -1, argv[i], size, NULL, NULL)) goto done;
  }
  result = publication_main(argc, argv);
done:
  for (int i = 0; i < allocated; ++i) free(argv[i]);
  free(argv);
  return result;
}
#else
int main(int argc, char **argv) { return publication_main(argc, argv); }
#endif
