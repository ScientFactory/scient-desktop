/* Namespace-only ABI. No descriptor is transferred to the calling process. */
#ifndef SCIENT_PUBLICATION_PLATFORM_H
#define SCIENT_PUBLICATION_PLATFORM_H
#include <stddef.h>
#include <stdint.h>

typedef struct {
  char dev[48];
  char ino[48];
  const char *type;
  int present;
} Entry;
typedef struct Context Context;
/* Zero is a completed flush; -1 is not attempted/not applicable; positive is the OS error. */
typedef struct {
  int source_file, destination_file, source_directory, destination_directory;
} Flush;
const char *platform_domain(void);
int platform_unsupported(void);
int platform_invalid(void);
int platform_changed(void);
int platform_exchange_available(void);
int platform_atomic_metadata_available(void);
/* Read-only actual-volume inquiry; a NULL root never qualifies creation. */
int platform_atomic_create_available(const char *root);
int platform_shared_lease_available(void);
const char *platform_containment(void);
Context *platform_bind(const char *root, const char *parent, const char *record, int *error);
void platform_close(Context *context);
int platform_binding(Context *context, Entry *root, Entry *parent, Entry *record);
int platform_strict_available(void);
int platform_policy(Context *context, const char *mode, const char *root, const char *record);
Context *platform_bind_parent(const char *root, const char *parent, int *error);
int platform_parent_binding(Context *context, Entry *root, Entry *parent);
int platform_lock_parent(Context *context, int exclusive);
void platform_unlock_parent(Context *context);
int platform_run_command(int argc, char **argv, int *exit_code, int *signal);
int platform_private_directory(Context *context, const char *name, Entry *entry);
int platform_mkdir(Context *context, const char *name, int private_directory, Entry *created,
                   Flush *flush, int *applied);
int platform_operation(Context *context, const char *operation, const char *source,
                       const char *destination, Entry *before, Entry *after_source,
                       Entry *after_destination, Flush *flush, int *applied);
#ifdef SCIENT_PUBLICATION_PROBE
int platform_probe_policy(Context *context, const char *mode, const char *root, const char *record);
int platform_probe_barrier(const char *label);
#endif
#endif
