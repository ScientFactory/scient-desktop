#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include "publication-platform.h"
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 1
#endif
/* Keep every ancestor open, excluding both delete and write sharing. Existing incompatible
 * handles make binding fail; we never weaken sharing modes to make the call succeed. */
struct Context {
  HANDLE *ancestors; size_t count, capacity;
  HANDLE root, parent, record, mutex;
  int mutex_owned;
};
typedef NTSTATUS (NTAPI *CreateNtFile)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG (WINAPI *NtError)(NTSTATUS);
typedef NTSTATUS (NTAPI *SetNtInformation)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef NTSTATUS (NTAPI *QueryNtInformation)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
static QueryNtInformation nt_query;
static SetNtInformation nt_set;
static CreateNtFile nt_create;
static NtError nt_error;
const char *platform_domain(void) { return "win32"; }
int platform_unsupported(void) { return ERROR_NOT_SUPPORTED; }
int platform_invalid(void) { return ERROR_INVALID_PARAMETER; }
int platform_changed(void) { return ERROR_FILE_INVALID; }
int platform_exchange_available(void) { return 0; }
int platform_atomic_metadata_available(void) { return 0; }
int platform_atomic_create_available(const char *root) { (void)root; return 0; }
int platform_shared_lease_available(void) { return 0; }
int platform_strict_available(void) { return 1; }
const char *platform_containment(void) { return "windows-pinned-ancestors"; }
static wchar_t *wide(const char *text) {
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
  if (!size) return NULL;
  wchar_t *result = malloc((size_t)size * sizeof(*result));
  if (!result) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, result, size)) {
    DWORD error = GetLastError(); free(result); SetLastError(error); return NULL;
  }
  return result;
}
static int identify(HANDLE handle, Entry *entry) {
  FILE_ID_INFO id;
  FILE_ATTRIBUTE_TAG_INFO attributes;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)))
    return (int)GetLastError();
  snprintf(entry->dev, sizeof(entry->dev), "%llu", (unsigned long long)id.VolumeSerialNumber);
  for (size_t i = 0; i < sizeof(id.FileId.Identifier); ++i)
    snprintf(entry->ino + i * 2, sizeof(entry->ino) - i * 2, "%02x", id.FileId.Identifier[i]);
  entry->present = 1;
  entry->type = (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? "reparse" :
                (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? "directory" : "file";
  return 0;
}
static HANDLE open_relative(HANDLE parent, const wchar_t *name, ACCESS_MASK access, ULONG options,
                            ULONG sharing) {
  size_t bytes = wcslen(name) * sizeof(wchar_t);
  if (bytes > 65532) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return INVALID_HANDLE_VALUE; }
  UNICODE_STRING string;
  string.Buffer = (PWSTR)name; string.Length = (USHORT)bytes; string.MaximumLength = (USHORT)bytes;
  OBJECT_ATTRIBUTES attributes;
  memset(&attributes, 0, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent;
  attributes.ObjectName = &string; attributes.Attributes = OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK status;
  HANDLE handle = INVALID_HANDLE_VALUE;
  NTSTATUS code = nt_create(&handle, access | SYNCHRONIZE, &attributes, &status, NULL, 0,
    sharing, FILE_OPEN, options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
  if (code < 0) { SetLastError(nt_error(code)); return INVALID_HANDLE_VALUE; }
  return handle;
}
static int remember(Context *context, HANDLE handle) {
  if (context->count == context->capacity) {
    size_t capacity = context->capacity ? context->capacity * 2 : 16;
    HANDLE *handles = realloc(context->ancestors, capacity * sizeof(*handles));
    if (!handles) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return 0; }
    context->ancestors = handles; context->capacity = capacity;
  }
  context->ancestors[context->count++] = handle;
  return 1;
}
static HANDLE walk(Context *context, HANDLE base, const wchar_t *relative) {
  if (!relative[0] || !wcscmp(relative, L".")) return base;
  wchar_t *copy = _wcsdup(relative);
  if (!copy) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return INVALID_HANDLE_VALUE; }
  HANDLE current = base;
  wchar_t *next = copy;
  for (;;) {
    wchar_t *separator = wcspbrk(next, L"/\\");
    if (separator) *separator = 0;
    if (!next[0] || !wcscmp(next, L".") || !wcscmp(next, L"..") || wcschr(next, L':')) {
      SetLastError(ERROR_INVALID_NAME); current = INVALID_HANDLE_VALUE; break;
    }
    HANDLE child = open_relative(current, next, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_DIRECTORY_FILE, FILE_SHARE_READ);
    if (child == INVALID_HANDLE_VALUE) { current = child; break; }
    Entry entry = {0};
    int error = identify(child, &entry);
    if (!error && strcmp(entry.type, "directory")) error = ERROR_REPARSE_TAG_INVALID;
    if (error || !remember(context, child)) {
      if (!error) error = (int)GetLastError();
      CloseHandle(child); SetLastError((DWORD)error); current = INVALID_HANDLE_VALUE; break;
    }
    current = child;
    if (!separator) break;
    next = separator + 1;
  }
  DWORD error = GetLastError(); free(copy); SetLastError(error);
  return current;
}
static HANDLE absolute_directory(Context *context, const char *path) {
  wchar_t *name = wide(path);
  if (!name) return INVALID_HANDLE_VALUE;
  /* Local DOS volumes only. UNC, device namespaces and junctions are not silently normalized. */
  if (wcslen(name) < 3 || name[1] != L':' || (name[2] != L'\\' && name[2] != L'/')) {
    free(name); SetLastError(ERROR_NOT_SUPPORTED); return INVALID_HANDLE_VALUE;
  }
  wchar_t volume[] = L"\\\\?\\C:\\";
  volume[4] = name[0];
  HANDLE drive = CreateFileW(volume, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (drive == INVALID_HANDLE_VALUE) { DWORD error = GetLastError(); free(name); SetLastError(error); return drive; }
  if (!remember(context, drive)) {
    DWORD error = GetLastError(); CloseHandle(drive); free(name); SetLastError(error); return INVALID_HANDLE_VALUE;
  }
  HANDLE result = walk(context, drive, name + 3);
  DWORD error = GetLastError(); free(name); SetLastError(error);
  return result;
}
static int private_security(HANDLE object, SE_OBJECT_TYPE kind, PSID expected_owner) {
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD error = GetSecurityInfo(object, kind, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                               &owner, NULL, &dacl, NULL, &descriptor);
  if (error) return (int)error;
  HANDLE token = NULL;
  TOKEN_USER *user = NULL;
  DWORD length = 0;
  if (!expected_owner) {
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { error = GetLastError(); goto done; }
    GetTokenInformation(token, TokenUser, NULL, 0, &length);
    user = malloc(length);
    if (!user) { error = ERROR_NOT_ENOUGH_MEMORY; goto done; }
    if (!GetTokenInformation(token, TokenUser, user, length, &length)) { error = GetLastError(); goto done; }
    expected_owner = user->User.Sid;
  }
  if (kind == SE_FILE_OBJECT) {
    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) { error = GetLastError(); goto done; }
    if (!(control & SE_DACL_PROTECTED)) { error = ERROR_ACCESS_DENIED; goto done; }
  }
  if (!dacl || !owner || !EqualSid(owner, expected_owner)) { error = ERROR_ACCESS_DENIED; goto done; }
  int owner_allowed = 0, system_allowed = 0;
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void *ace = NULL;
    if (!GetAce(dacl, i, &ace)) { error = GetLastError(); goto done; }
    ACE_HEADER *header = ace;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
      ACCESS_DENIED_ACE *denied = ace;
      if (denied->Mask) { error = ERROR_ACCESS_DENIED; goto done; }
      continue;
    }
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { error = ERROR_ACCESS_DENIED; goto done; }
    ACCESS_ALLOWED_ACE *allowed = ace;
    PSID sid = &allowed->SidStart;
    if (!(header->AceFlags & INHERIT_ONLY_ACE) && allowed->Mask) {
      if (EqualSid(sid, expected_owner)) owner_allowed = 1;
      if (IsWellKnownSid(sid, WinLocalSystemSid)) system_allowed = 1;
    }
    if (allowed->Mask && !EqualSid(sid, expected_owner) && !IsWellKnownSid(sid, WinLocalSystemSid)) {
      error = ERROR_ACCESS_DENIED; goto done;
    }
  }
  if (kind == SE_FILE_OBJECT && (!owner_allowed || !system_allowed)) error = ERROR_ACCESS_DENIED;
done:
  free(user); if (token) CloseHandle(token); if (descriptor) LocalFree(descriptor);
  return (int)error;
}
static int current_user_security(PSECURITY_DESCRIPTOR *descriptor, wchar_t **sid, int directory) {
  HANDLE token = NULL;
  TOKEN_USER *user = NULL;
  DWORD length = 0, error = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return (int)GetLastError();
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  user = malloc(length);
  if (!user) { error = ERROR_NOT_ENOUGH_MEMORY; goto done; }
  if (!GetTokenInformation(token, TokenUser, user, length, &length) ||
      !ConvertSidToStringSidW(user->User.Sid, sid)) { error = GetLastError(); goto done; }
  wchar_t security[256];
  const wchar_t *pattern = directory ? L"O:%lsD:P(A;OICI;GA;;;%ls)(A;OICI;GA;;;SY)" :
    L"O:%lsD:P(A;;GA;;;%ls)(A;;GA;;;SY)";
  if (swprintf(security, 256, pattern, *sid, *sid) < 0) {
    error = ERROR_FILENAME_EXCED_RANGE; goto done;
  }
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(security, SDDL_REVISION_1, descriptor, NULL))
    error = GetLastError();
done:
  free(user); CloseHandle(token); return (int)error;
}
Context *platform_bind_parent(const char *root, const char *parent, int *error) {
  HMODULE library = GetModuleHandleW(L"ntdll.dll");
  /* memcpy avoids incompatible function-pointer casts under -Werror. */
  FARPROC create_address = library ? GetProcAddress(library, "NtCreateFile") : NULL;
  FARPROC error_address = library ? GetProcAddress(library, "RtlNtStatusToDosError") : NULL;
  FARPROC set_address = library ? GetProcAddress(library, "NtSetInformationFile") : NULL;
  FARPROC query_address = library ? GetProcAddress(library, "NtQueryInformationFile") : NULL;
  memcpy(&nt_create, &create_address, sizeof(nt_create));
  memcpy(&nt_error, &error_address, sizeof(nt_error));
  memcpy(&nt_set, &set_address, sizeof(nt_set));
  memcpy(&nt_query, &query_address, sizeof(nt_query));
  if (!nt_create || !nt_error || !nt_set || !nt_query) { *error = ERROR_PROC_NOT_FOUND; return NULL; }
  Context *context = calloc(1, sizeof(*context));
  if (!context) { *error = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
  context->root = absolute_directory(context, root);
  if (context->root == INVALID_HANDLE_VALUE) goto fail;
  wchar_t *relative = wide(parent);
  if (!relative) goto fail;
  context->parent = walk(context, context->root, relative);
  DWORD code = GetLastError(); free(relative); SetLastError(code);
  if (context->parent == INVALID_HANDLE_VALUE) goto fail;
  return context;
fail:
  *error = (int)GetLastError(); platform_close(context); return NULL;
}
Context *platform_bind(const char *root, const char *parent, const char *record, int *error) {
  Context *context = platform_bind_parent(root, parent, error);
  if (!context) return NULL;
  context->record = absolute_directory(context, record);
  if (context->record == INVALID_HANDLE_VALUE) goto fail;
  *error = private_security(context->record, SE_FILE_OBJECT, NULL);
  if (*error) { platform_close(context); return NULL; }
  Entry a = {0}, b = {0}, c = {0};
  *error = platform_binding(context, &a, &b, &c);
  if (!*error && (strcmp(a.dev, b.dev) || strcmp(b.dev, c.dev))) *error = ERROR_NOT_SAME_DEVICE;
  if (*error) { platform_close(context); return NULL; }
  return context;
fail:
  *error = (int)GetLastError(); platform_close(context); return NULL;
}
void platform_close(Context *context) {
  platform_unlock_parent(context);
  if (context->mutex) CloseHandle(context->mutex);
  while (context->count) CloseHandle(context->ancestors[--context->count]);
  free(context->ancestors); free(context);
}
int platform_binding(Context *context, Entry *root, Entry *parent, Entry *record) {
  int error = identify(context->root, root);
  if (!error) error = identify(context->parent, parent);
  if (!error) error = identify(context->record, record);
  return error;
}
int platform_parent_binding(Context *context, Entry *root, Entry *parent) {
  int error = identify(context->root, root);
  return error ? error : identify(context->parent, parent);
}
int platform_lock_parent(Context *context, int exclusive) {
  /* A named mutex is EX, not SH. Shared cross-process ownership is unqualified
   * on Windows, so ancestor-SH product callers fail before namespace work. */
  if (!exclusive) return ERROR_NOT_SUPPORTED;
  Entry parent = {0};
  int error = identify(context->parent, &parent);
  if (error) return error;
  wchar_t *sid = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  error = current_user_security(&descriptor, &sid, 0);
  if (error) goto done;
  PSID owner = NULL;
  BOOL defaulted = FALSE;
  if (!GetSecurityDescriptorOwner(descriptor, &owner, &defaulted)) { error = (int)GetLastError(); goto done; }
  wchar_t name[256];
  SECURITY_ATTRIBUTES attributes = { (DWORD)sizeof(attributes), descriptor, FALSE };
  if (swprintf(name, 256, L"Global\\ScientPublication-%ls-%hs-%hs", sid, parent.dev, parent.ino) < 0) {
    error = ERROR_FILENAME_EXCED_RANGE; goto done;
  }
  context->mutex = CreateMutexExW(&attributes, name, 0, SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL);
  if (!context->mutex) { error = (int)GetLastError(); goto done; }
  error = private_security(context->mutex, SE_KERNEL_OBJECT, owner);
  if (error) goto done;
  DWORD timeout = INFINITE;
#ifdef SCIENT_PUBLICATION_PROBE
  if (getenv("SCIENT_LEASE_PROBE")) { printf("LEASE_WAIT\n"); fflush(stdout); }
  if (getenv("SCIENT_LEASE_TRY")) timeout = 0;
#endif
  DWORD result = WaitForSingleObject(context->mutex, timeout);
  if (result == WAIT_OBJECT_0 || result == WAIT_ABANDONED_0) {
    context->mutex_owned = 1;
    if (result == WAIT_ABANDONED_0) error = ERROR_ABANDONED_WAIT_0;
  } else error = result == WAIT_FAILED ? (int)GetLastError() : ERROR_GEN_FAILURE;
done:
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  return error;
}
void platform_unlock_parent(Context *context) {
  if (context->mutex_owned) { ReleaseMutex(context->mutex); context->mutex_owned = 0; }
}
static int inspect(HANDLE directory, const wchar_t *name, Entry *entry) {
  HANDLE handle = open_relative(directory, name, FILE_READ_ATTRIBUTES, 0,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? 0 : (int)error;
  }
  int error = identify(handle, entry); CloseHandle(handle); return error;
}
static int flush_handle(HANDLE handle) { return FlushFileBuffers(handle) ? 0 : (int)GetLastError(); }
static int flush_entry(HANDLE directory, const wchar_t *name, const Entry *expected) {
  if (!expected->present || strcmp(expected->type, "file")) return -1;
  HANDLE handle = open_relative(directory, name, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES, 0,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  if (handle == INVALID_HANDLE_VALUE) return (int)GetLastError();
  Entry observed = {0};
  int error = identify(handle, &observed);
  if (!error && (strcmp(expected->dev, observed.dev) || strcmp(expected->ino, observed.ino)))
    error = ERROR_FILE_INVALID;
  if (!error) error = flush_handle(handle);
  CloseHandle(handle); return error;
}
int platform_private_directory(Context *context, const char *name, Entry *entry) {
  wchar_t *component = wide(name);
  if (!component) return (int)GetLastError();
  HANDLE directory = open_relative(context->parent, component,
    FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_DIRECTORY_FILE, FILE_SHARE_READ);
  DWORD code = GetLastError(); free(component);
  if (directory == INVALID_HANDLE_VALUE) return (int)code;
  int error = identify(directory, entry);
  if (!error && strcmp(entry->type, "directory")) error = ERROR_REPARSE_TAG_INVALID;
  if (!error) error = private_security(directory, SE_FILE_OBJECT, NULL);
  CloseHandle(directory);
  return error;
}

int platform_mkdir(Context *context, const char *name, int private_directory, Entry *created,
                   Flush *flush, int *applied) {
  wchar_t *component = wide(name), *sid = NULL;
  if (!component) return (int)GetLastError();
  PSECURITY_DESCRIPTOR descriptor = NULL;
  int error = private_directory ? current_user_security(&descriptor, &sid, 1) : 0;
  HANDLE directory = INVALID_HANDLE_VALUE;
  if (!error) {
    size_t bytes = wcslen(component) * sizeof(wchar_t);
    if (bytes > 65532) error = ERROR_FILENAME_EXCED_RANGE;
    else {
      UNICODE_STRING string = { (USHORT)bytes, (USHORT)bytes, component };
      OBJECT_ATTRIBUTES attributes;
      memset(&attributes, 0, sizeof(attributes));
      attributes.Length = sizeof(attributes); attributes.RootDirectory = context->parent;
      attributes.ObjectName = &string; attributes.Attributes = OBJ_CASE_INSENSITIVE;
      attributes.SecurityDescriptor = descriptor;
      IO_STATUS_BLOCK status;
      NTSTATUS code = nt_create(&directory, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL |
        SYNCHRONIZE, &attributes, &status, NULL, FILE_ATTRIBUTE_DIRECTORY, FILE_SHARE_READ,
        2 /* FILE_CREATE: an existing entry is never followed or modified. */,
        FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
      if (code < 0) error = (int)nt_error(code);
      else {
        *applied = 1;
        error = identify(directory, created);
        if (!error && private_directory) error = private_security(directory, SE_FILE_OBJECT, NULL);
        flush->source_directory = flush_handle(context->parent);
        flush->destination_directory = flush_handle(directory);
      }
    }
  }
  if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  free(component);
  return error;
}

static int copy_metadata(Context *context, const wchar_t *source, const wchar_t *destination,
                         Entry *before, Entry *after_source, Entry *after_destination,
                         Flush *flush, int *applied) {
  HANDLE input = open_relative(context->parent, source,
    FILE_READ_ATTRIBUTES | READ_CONTROL, 0, FILE_SHARE_READ);
  if (input == INVALID_HANDLE_VALUE) return (int)GetLastError();
  HANDLE output = open_relative(context->record, destination,
    FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | WRITE_DAC | WRITE_OWNER | READ_CONTROL,
    0, FILE_SHARE_READ);
  int error = output == INVALID_HANDLE_VALUE ? (int)GetLastError() : identify(input, before);
  Entry staged = {0};
  if (!error) error = identify(output, &staged);
  if (!error && (strcmp(before->type, "file") || strcmp(staged.type, "file"))) error = ERROR_INVALID_PARAMETER;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL, group = NULL;
  PACL dacl = NULL;
  if (!error) error = (int)GetSecurityInfo(input, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, &group, &dacl, NULL, &descriptor);
  if (!error) {
    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) error = (int)GetLastError();
    else {
      *applied = 1;
      error = (int)SetSecurityInfo(output, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
        ((control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION),
        owner, group, dacl, NULL);
    }
  }
  FILE_BASIC_INFO attributes;
  if (!error && !GetFileInformationByHandleEx(input, FileBasicInfo, &attributes, sizeof(attributes)))
    error = (int)GetLastError();
  if (!error && !SetFileInformationByHandle(output, FileBasicInfo, &attributes, sizeof(attributes)))
    error = (int)GetLastError();
  if (output != INVALID_HANDLE_VALUE) {
    flush->destination_file = flush_handle(output);
    int observed = identify(output, after_destination);
    if (!error) error = observed;
    CloseHandle(output);
  }
  int observed = identify(input, after_source);
  if (!error) error = observed;
  if (descriptor) LocalFree(descriptor);
  CloseHandle(input);
  return error;
}
/* Native FileLinkInformation is class 11, not Win32's unrelated class 11. */
int platform_operation(Context *context, const char *operation, const char *source,
                       const char *destination, Entry *before, Entry *after_source,
                       Entry *after_destination, Flush *flush, int *applied) {
  if (!strcmp(operation, "exchange") || !strcmp(operation, "create")) return ERROR_NOT_SUPPORTED;
  if (!strcmp(operation, "mkdir"))
    return platform_mkdir(context, source, 0, after_destination, flush, applied);
  HANDLE from = !strcmp(operation, "capture") ? context->parent : context->record;
  HANDLE to = !strcmp(operation, "capture") ? context->record : context->parent;
  wchar_t *source_wide = wide(source), *destination_wide = wide(destination);
  if (!source_wide || !destination_wide) {
    DWORD error = GetLastError(); free(source_wide); free(destination_wide); return (int)error;
  }
  if (!strcmp(operation, "metadata")) {
    int error = copy_metadata(context, source_wide, destination_wide,
      before, after_source, after_destination, flush, applied);
    free(source_wide); free(destination_wide); return error;
  }
  HANDLE entry = open_relative(from, source_wide, DELETE | FILE_READ_ATTRIBUTES, 0,
                               FILE_SHARE_READ | FILE_SHARE_WRITE);
  if (entry == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError(); free(source_wide); free(destination_wide); return (int)error;
  }
  int error = identify(entry, before);
  if (!error && !strcmp(operation, "link") && strcmp(before->type, "file")) error = ERROR_INVALID_PARAMETER;
  if (!error && !strcmp(operation, "rmdir")) {
    if (strcmp(before->type, "directory")) error = ERROR_INVALID_PARAMETER;
    else {
      FILE_DISPOSITION_INFO disposition = { TRUE };
      if (!SetFileInformationByHandle(entry, FileDispositionInfo, &disposition, sizeof(disposition)))
        error = (int)GetLastError();
      else *applied = 1;
    }
    CloseHandle(entry);
    if (*applied) flush->source_directory = flush_handle(from);
    free(source_wide); free(destination_wide); return error;
  }
  size_t bytes = wcslen(destination_wide) * sizeof(wchar_t);
  size_t size = offsetof(FILE_RENAME_INFO, FileName) + bytes + sizeof(wchar_t);
  FILE_RENAME_INFO *rename = NULL;
  if (!error) {
    rename = calloc(1, size);
    if (!rename) error = ERROR_NOT_ENOUGH_MEMORY;
  }
  if (!error) {
    rename->ReplaceIfExists = FALSE; rename->RootDirectory = to; rename->FileNameLength = (DWORD)bytes;
    memcpy(rename->FileName, destination_wide, bytes);
    if (!strcmp(operation, "link")) {
      IO_STATUS_BLOCK status;
      NTSTATUS code = nt_set(entry, &status, rename, (ULONG)size, (FILE_INFORMATION_CLASS)11);
      if (code < 0) error = (int)nt_error(code);
    } else if (!SetFileInformationByHandle(entry, FileRenameInfo, rename, (DWORD)size)) {
      error = (int)GetLastError();
    }
    if (!error) {
      *applied = 1;
      error = inspect(from, source_wide, after_source);
      int destination_error = inspect(to, destination_wide, after_destination);
      if (!error) error = destination_error;
      /* Directory FlushFileBuffers may be unsupported; the raw outcome is never hidden. */
      flush->source_directory = flush_handle(from);
      flush->destination_directory = flush_handle(to);
      flush->source_file = flush_entry(from, source_wide, after_source);
      flush->destination_file = flush_entry(to, destination_wide, after_destination);
    }
  }
  free(rename); CloseHandle(entry); free(source_wide); free(destination_wide);
  return error;
}
int platform_policy(Context *context, const char *mode, const char *root, const char *record) {
  (void)context; (void)mode; (void)root; (void)record;
  /* Enforcement is the held, validated, no-reparse ancestor handle chain itself. */
  return 0;
}
#ifdef SCIENT_PUBLICATION_PROBE
int platform_probe_policy(Context *context, const char *mode, const char *root, const char *record) {
  (void)context; (void)mode; (void)root; (void)record; return ERROR_NOT_SUPPORTED;
}
#endif
