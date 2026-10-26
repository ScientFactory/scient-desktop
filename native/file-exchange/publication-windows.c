#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include "publication-platform.h"
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <fltuser.h>
#include <cfapi.h>
#ifdef SCIENT_PUBLICATION_PROBE
#include <lm.h>
#pragma comment(lib, "Netapi32.lib")
#endif
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
/* Exclude delete sharing to pin ancestors while allowing edits to their children. */
struct Context {
  HANDLE *ancestors; size_t count, capacity;
  HANDLE root, parent, record, lock;
  int lock_owned;
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
typedef NTSTATUS (NTAPI *SetNtSecurity)(HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR);
static SetNtSecurity nt_security;
const char *platform_domain(void) { return "win32"; }
int platform_unsupported(void) { return ERROR_NOT_SUPPORTED; }
int platform_invalid(void) { return ERROR_INVALID_PARAMETER; }
int platform_changed(void) { return ERROR_FILE_INVALID; }
int platform_exchange_available(void) { return 0; }
int platform_atomic_metadata_available(void) { return 0; }
static int qualified_volume(HANDLE folder);
int platform_atomic_create_available(const char *root) { (void)root; return 0; }
int platform_windows_available(const char *root) {
  if (!root) return 1;
  int error = 0;
  Context *context = platform_bind_parent(root, ".", &error);
  int available = context && !qualified_volume(context->parent);
  if (context) platform_close(context);
  return available;
}
int platform_shared_lease_available(void) { return 1; }
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
static wchar_t *wide_path(const char *text) {
  wchar_t *path = wide(text);
  if (!path) return NULL;
  size_t length = wcslen(path);
  if (length >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    wchar_t *extended = malloc((length + 5) * sizeof(wchar_t));
    if (!extended) { free(path); SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    memcpy(extended, L"\\\\?\\", 4 * sizeof(wchar_t));
    memcpy(extended + 4, path, (length + 1) * sizeof(wchar_t));
    free(path); path = extended;
    for (size_t i = 4; i < length + 4; ++i) if (path[i] == L'/') path[i] = L'\\';
  }
  return path;
}
static int cloud_tag(DWORD tag) { return (tag & ~0x0000f000UL) == 0x9000001aUL; }
static int identify(HANDLE handle, Entry *entry) {
  FILE_ID_INFO id;
  FILE_ATTRIBUTE_TAG_INFO attributes;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)))
    return (int)GetLastError();
  wchar_t path[32768], volume[64], normalized[64];
  DWORD length = GetFinalPathNameByHandleW(handle, path, 32768, VOLUME_NAME_GUID);
  if (!length || length >= 32768 || wcsncmp(path, L"\\\\?\\Volume{", 11) || wcslen(path) < 49)
    return ERROR_NOT_SUPPORTED;
  memcpy(volume, path, 49 * sizeof(wchar_t)); volume[49] = 0;
  if (!GetVolumeNameForVolumeMountPointW(volume, normalized, 64)) return (int)GetLastError();
  for (size_t i = 0; i < 36; ++i) {
    wchar_t value = normalized[11 + i];
    entry->dev[i] = (char)(value >= L'a' && value <= L'f' ? value - L'a' + L'A' : value);
  }
  entry->dev[36] = 0;
  for (size_t i = 0; i < sizeof(id.FileId.Identifier); ++i)
    snprintf(entry->ino + i * 2, sizeof(entry->ino) - i * 2, "%02x", id.FileId.Identifier[i]);
  entry->present = 1;
  entry->type = (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && !cloud_tag(attributes.ReparseTag) ? "reparse" :
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
                                 FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE);
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
    int network = name[0] == L'\\' && name[1] == L'\\';
    free(name); SetLastError(network ? 0x20000005 : ERROR_NOT_SUPPORTED); return INVALID_HANDLE_VALUE;
  }
  wchar_t dos[] = L"C:", device[32768], drive_root[] = L"C:\\";
  dos[0] = name[0]; drive_root[0] = name[0];
  UINT kind = GetDriveTypeW(drive_root);
  if ((kind != DRIVE_FIXED && kind != DRIVE_REMOVABLE) ||
      !QueryDosDeviceW(dos, device, 32768) || wcsncmp(device, L"\\Device\\HarddiskVolume", 22)) {
    free(name); SetLastError(0x20000005); return INVALID_HANDLE_VALUE;
  }
  wchar_t volume[] = L"\\\\?\\C:\\";
  volume[4] = name[0];
  HANDLE drive = CreateFileW(volume, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (drive == INVALID_HANDLE_VALUE) { DWORD error = GetLastError(); free(name); SetLastError(error); return drive; }
  int admission = qualified_volume(drive);
  if (admission) { CloseHandle(drive); free(name); SetLastError((DWORD)admission); return INVALID_HANDLE_VALUE; }
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
static int inherited_user_security(PSECURITY_DESCRIPTOR *descriptor) {
  PSECURITY_DESCRIPTOR private_descriptor = NULL; wchar_t *sid = NULL;
  int error = current_user_security(&private_descriptor, &sid, 0);
  if (!error) {
    wchar_t owner[256];
    if (swprintf(owner, 256, L"O:%ls", sid) < 0) error = ERROR_FILENAME_EXCED_RANGE;
    else if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(owner, SDDL_REVISION_1, descriptor, NULL)) error = (int)GetLastError();
  }
  if (private_descriptor) LocalFree(private_descriptor);
  if (sid) LocalFree(sid);
  return error;
}
Context *platform_bind_parent(const char *root, const char *parent, int *error) {
  HMODULE library = GetModuleHandleW(L"ntdll.dll");
  /* memcpy avoids incompatible function-pointer casts under -Werror. */
  FARPROC create_address = library ? GetProcAddress(library, "NtCreateFile") : NULL;
  FARPROC error_address = library ? GetProcAddress(library, "RtlNtStatusToDosError") : NULL;
  FARPROC set_address = library ? GetProcAddress(library, "NtSetInformationFile") : NULL;
  FARPROC security_address = library ? GetProcAddress(library, "NtSetSecurityObject") : NULL;
  FARPROC query_address = library ? GetProcAddress(library, "NtQueryInformationFile") : NULL;
  memcpy(&nt_security, &security_address, sizeof(nt_security));
  memcpy(&nt_create, &create_address, sizeof(nt_create));
  memcpy(&nt_error, &error_address, sizeof(nt_error));
  memcpy(&nt_set, &set_address, sizeof(nt_set));
  memcpy(&nt_query, &query_address, sizeof(nt_query));
  if (!nt_create || !nt_error || !nt_set || !nt_query || !nt_security) { *error = ERROR_PROC_NOT_FOUND; return NULL; }
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
  if (context->lock) CloseHandle(context->lock);
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
static HANDLE create_relative(HANDLE parent, const wchar_t *name, ACCESS_MASK access,
                              ULONG disposition, ULONG attributes, PSECURITY_DESCRIPTOR security, ULONG sharing) {
  size_t bytes = wcslen(name) * sizeof(wchar_t);
  if (bytes > 65532) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return INVALID_HANDLE_VALUE; }
  UNICODE_STRING string = { (USHORT)bytes, (USHORT)bytes, (PWSTR)name };
  OBJECT_ATTRIBUTES object;
  memset(&object, 0, sizeof(object));
  object.Length = sizeof(object); object.RootDirectory = parent;
  object.ObjectName = &string; object.Attributes = OBJ_CASE_INSENSITIVE;
  object.SecurityDescriptor = security;
  HANDLE handle = INVALID_HANDLE_VALUE;
  IO_STATUS_BLOCK status;
  NTSTATUS code = nt_create(&handle, access | SYNCHRONIZE, &object, &status, NULL,
    attributes, sharing, disposition,
    FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
  if (code < 0) { SetLastError(nt_error(code)); return INVALID_HANDLE_VALUE; }
  return handle;
}
#ifdef SCIENT_PUBLICATION_PROBE
static HRESULT probe_filter_status = E_UNEXPECTED;
static DWORD probe_path_error;
static HRESULT probe_instance_status = E_UNEXPECTED;
#endif
static int cloud_filter_absent(HANDLE folder) {
  HMODULE library = LoadLibraryW(L"fltlib.dll");
  if (!library) return 0;
  typedef HRESULT (WINAPI *First)(LPCWSTR, INSTANCE_INFORMATION_CLASS, LPVOID, DWORD, LPDWORD, LPHANDLE);
  typedef HRESULT (WINAPI *Next)(HANDLE, INSTANCE_INFORMATION_CLASS, LPVOID, DWORD, LPDWORD);
  typedef HRESULT (WINAPI *Close)(HANDLE);
  First first = NULL; Next next = NULL; Close close = NULL;
  FARPROC address = GetProcAddress(library, "FilterVolumeInstanceFindFirst"); memcpy(&first, &address, sizeof(first));
  address = GetProcAddress(library, "FilterVolumeInstanceFindNext"); memcpy(&next, &address, sizeof(next));
  address = GetProcAddress(library, "FilterVolumeInstanceFindClose"); memcpy(&close, &address, sizeof(close));
  wchar_t volume[32768];
  DWORD length = GetFinalPathNameByHandleW(folder, volume, 32768, VOLUME_NAME_NT);
#ifdef SCIENT_PUBLICATION_PROBE
  probe_path_error = length ? 0 : GetLastError();
#endif
  int absent = 0;
  if (first && next && close && length && length < 32768 && !wcsncmp(volume, L"\\Device\\", 8)) {
    wchar_t *end = wcschr(volume + 8, L'\\');
    if (end) *end = 0;
    union { ULONGLONG aligned; BYTE bytes[65536]; } buffer;
    HANDLE search = INVALID_HANDLE_VALUE; DWORD returned = 0;
    HRESULT result = first(volume, InstanceFullInformation, buffer.bytes, sizeof(buffer.bytes), &returned, &search);
    int found = 0;
    while (SUCCEEDED(result)) {
      INSTANCE_FULL_INFORMATION *info = (INSTANCE_FULL_INFORMATION *)buffer.bytes;
      if (returned < sizeof(*info) || (DWORD)info->FilterNameBufferOffset + info->FilterNameLength > returned) { found = 1; break; }
      if (info->FilterNameLength == 12 && !_wcsnicmp((PWSTR)(buffer.bytes + info->FilterNameBufferOffset), L"CldFlt", 6)) { found = 1; break; }
      result = next(search, InstanceFullInformation, buffer.bytes, sizeof(buffer.bytes), &returned);
    }
#ifdef SCIENT_PUBLICATION_PROBE
    probe_filter_status = result;
#endif
    absent = !found && result == HRESULT_FROM_WIN32(ERROR_NO_MORE_ITEMS);
    if (search != INVALID_HANDLE_VALUE) close(search);
  }
  FreeLibrary(library); return absent;
}
static int cloud_managed(HANDLE folder) {
  typedef HRESULT (WINAPI *CloudInfo)(HANDLE, int, PVOID, DWORD, PDWORD);
  HMODULE library = LoadLibraryW(L"cldapi.dll");
  if (!library) return (int)GetLastError();
  FARPROC address = GetProcAddress(library, "CfGetSyncRootInfoByHandle");
  CloudInfo query = NULL;
  memcpy(&query, &address, sizeof(query));
  if (!query) { FreeLibrary(library); return ERROR_PROC_NOT_FOUND; }
  BYTE buffer[65536]; DWORD returned = 0;
  HRESULT result = query(folder, 0 /* CF_SYNC_ROOT_INFO_BASIC */, buffer, sizeof(buffer), &returned);

  FreeLibrary(library);
  /* A volume without CldFlt returns INVALID_FUNCTION even when the driver runs elsewhere. */
  if (result == HRESULT_FROM_WIN32(ERROR_INVALID_FUNCTION) && cloud_filter_absent(folder)) return 0;
  if (SUCCEEDED(result)) return 0x20000001; /* sync-managed-folder */
  return result == HRESULT_FROM_WIN32(ERROR_NOT_A_CLOUD_SYNC_ROOT) ||
    result == HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_NOT_UNDER_SYNC_ROOT) ? 0 : (int)HRESULT_CODE(result);
}
int platform_lock_parent(Context *context, int exclusive) {
  Entry parent = {0};
  int error = identify(context->parent, &parent);
  if (error) return error;
  wchar_t state[32768];
  DWORD length = GetEnvironmentVariableW(L"SCIENT_PUBLICATION_LOCK_ROOT", state, 32768);
  if (!length) {
    length = GetEnvironmentVariableW(L"LOCALAPPDATA", state, 32768);
    if (!length || length > 32600) return ERROR_BAD_ENVIRONMENT;
    wcscat_s(state, 32768, L"\\ScientPublicationLocks");
  }
  if (length >= 32768) return ERROR_FILENAME_EXCED_RANGE;
  PSECURITY_DESCRIPTOR descriptor = NULL; wchar_t *sid = NULL;
  error = current_user_security(&descriptor, &sid, 1);
  HANDLE directory = INVALID_HANDLE_VALUE;
  if (!error) {
    for (wchar_t *part = state; *part; ++part) if (*part == L'/') *part = L'\\';
    wchar_t *leaf = wcsrchr(state, L'\\');
    if (!leaf || !leaf[1]) error = ERROR_INVALID_NAME;
    else {
      *leaf++ = 0;
      int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, state, -1, NULL, 0, NULL, NULL);
      char *parent_path = bytes ? malloc((size_t)bytes + 1) : NULL;
      if (!parent_path) error = ERROR_NOT_ENOUGH_MEMORY;
      else {
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, state, -1, parent_path, bytes, NULL, NULL);
        if (bytes == 3 && parent_path[1] == ':') { parent_path[2] = '\\'; parent_path[3] = 0; }
        HANDLE parent_directory = absolute_directory(context, parent_path);
        free(parent_path);
        if (parent_directory == INVALID_HANDLE_VALUE) error = (int)GetLastError();
        else {
          USHORT size = (USHORT)(wcslen(leaf) * sizeof(wchar_t));
          UNICODE_STRING string = { size, size, leaf }; IO_STATUS_BLOCK status;
          OBJECT_ATTRIBUTES attributes = {0}; attributes.Length = sizeof(attributes);
          attributes.RootDirectory = parent_directory; attributes.ObjectName = &string;
          attributes.Attributes = OBJ_CASE_INSENSITIVE; attributes.SecurityDescriptor = descriptor;
          NTSTATUS result = nt_create(&directory, FILE_LIST_DIRECTORY | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &attributes, &status, NULL, FILE_ATTRIBUTE_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE,
            3 /* FILE_OPEN_IF leaves an existing policy unchanged. */,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
          if (result < 0) error = (int)nt_error(result);
          else if (!remember(context, directory)) {
            error = (int)GetLastError(); CloseHandle(directory); directory = INVALID_HANDLE_VALUE;
          }
        }
      }
    }
  }
  Entry state_entry = {0};
  if (!error) error = identify(directory, &state_entry);
  if (!error && strcmp(state_entry.type, "directory")) error = ERROR_REPARSE_TAG_INVALID;
  if (!error) error = private_security(directory, SE_FILE_OBJECT, NULL);
  if (!error) error = cloud_managed(directory);
  if (descriptor) LocalFree(descriptor); descriptor = NULL;
  if (sid) LocalFree(sid); sid = NULL;
  if (!error) error = current_user_security(&descriptor, &sid, 0);
  if (!error) {
    wchar_t name[128];
    swprintf(name, 128, L"%hs-%hs.lock", parent.dev, parent.ino);
    context->lock = create_relative(directory, name, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                                    3 /* FILE_OPEN_IF */, FILE_ATTRIBUTE_NORMAL, descriptor, FILE_SHARE_READ | FILE_SHARE_WRITE);
    if (context->lock == INVALID_HANDLE_VALUE) { context->lock = NULL; error = (int)GetLastError(); }
    else error = private_security(context->lock, SE_FILE_OBJECT, NULL);
  }
  if (!error) {
    OVERLAPPED overlapped = {0};
    DWORD flags = exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0;
#ifdef SCIENT_PUBLICATION_PROBE
    if (getenv("SCIENT_LEASE_PROBE")) { printf("LEASE_WAIT\n"); fflush(stdout); }
    if (getenv("SCIENT_LEASE_TRY")) flags |= LOCKFILE_FAIL_IMMEDIATELY;
#endif
    if (!LockFileEx(context->lock, flags, 0, 1, 0, &overlapped)) error = (int)GetLastError();
    else context->lock_owned = 1;
  }
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  return error;
}
void platform_unlock_parent(Context *context) {
  if (context->lock_owned) {
    OVERLAPPED overlapped = {0};
    UnlockFileEx(context->lock, 0, 1, 0, &overlapped); context->lock_owned = 0;
  }
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
static int flush_handle(HANDLE handle) {
  if (FlushFileBuffers(handle)) return 0;
  DWORD error = GetLastError();
  FILE_ATTRIBUTE_TAG_INFO attributes;
  if ((error == ERROR_ACCESS_DENIED || error == ERROR_INVALID_HANDLE || error == ERROR_INVALID_FUNCTION) &&
      GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
      (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return -1;
  return (int)error;
}
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
  if (!error) error = cloud_managed(directory);
  CloseHandle(directory);
  return error;
}

int platform_mkdir(Context *context, const char *name, int private_directory, Entry *created,
                   Flush *flush, int *applied) {
  wchar_t *component = wide(name), *sid = NULL;
  if (!component) return (int)GetLastError();
  PSECURITY_DESCRIPTOR descriptor = NULL;
  int error = private_directory ? cloud_managed(context->parent) : 0;
  if (!error && private_directory) error = current_user_security(&descriptor, &sid, 1);
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
int platform_remove(Context *context, const char *name, int directory,
                    Entry *before, Flush *flush, int *applied) {
  wchar_t *component = wide(name);
  if (!component) return (int)GetLastError();
  HANDLE child = open_relative(context->parent, component, DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
    directory ? FILE_DIRECTORY_FILE : 0, FILE_SHARE_READ);
  free(component);
  if (child == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? 0 : (int)error;
  }
  int error = identify(child, before);
  if (!error && directory != !strcmp(before->type, "directory")) error = ERROR_DIRECTORY;
  if (!error) {
    ULONG flags = 0x13; /* DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE */
    IO_STATUS_BLOCK status;
    NTSTATUS code = nt_set(child, &status, &flags, sizeof(flags), 64 /* FileDispositionInformationEx */);
    if (code < 0) error = (int)nt_error(code);
    else *applied = 1;
  }
  CloseHandle(child);
  if (*applied) flush->source_directory = flush_handle(context->parent);
  return error;
}
static int windows_operation(Context *, const char *, const char *, const char *, Entry *, Entry *, Entry *, Flush *, int *);
/* Native FileLinkInformation is class 11, not Win32's unrelated class 11. */
int platform_operation(Context *context, const char *operation, const char *source,
                       const char *destination, Entry *before, Entry *after_source,
                       Entry *after_destination, Flush *flush, int *applied) {
  if (!strncmp(operation, "win-", 4))
    return windows_operation(context, operation, source, destination, before, after_source, after_destination, flush, applied);
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
  (void)mode; (void)root; (void)record;
  int error = qualified_volume(context->root);
  if (!error && context->record) error = qualified_volume(context->record);
  if (!error && context->record) error = cloud_managed(context->record);
  return error;
}
#ifdef SCIENT_PUBLICATION_PROBE
int platform_probe_policy(Context *context, const char *mode, const char *root, const char *record) {
  (void)context; (void)mode; (void)root; (void)record; return ERROR_NOT_SUPPORTED;
}
#endif

/* Handles live in the lease process across journal acknowledgements, never in its caller. */
static struct {
  HANDLE original, stage;
  Entry original_id, stage_id, parent_id, record_id;
  int captured;
} transaction;
static void close_transaction(void) {
  if (transaction.original) CloseHandle(transaction.original);
  if (transaction.stage) CloseHandle(transaction.stage);
  memset(&transaction, 0, sizeof(transaction));
}
void platform_windows_retire(void) { close_transaction(); }
static int rename_handle(HANDLE file, HANDLE parent, const wchar_t *name) {
  size_t bytes = wcslen(name) * sizeof(wchar_t);
  size_t size = offsetof(FILE_RENAME_INFO, FileName) + bytes + sizeof(wchar_t);
  FILE_RENAME_INFO *rename = calloc(1, size);
  if (!rename) return ERROR_NOT_ENOUGH_MEMORY;
  rename->Flags = 0; /* Non-replacing capture/install never enables replacement semantics. */
  rename->RootDirectory = parent; rename->FileNameLength = (DWORD)bytes;
  memcpy(rename->FileName, name, bytes);
  IO_STATUS_BLOCK status;
  NTSTATUS result = nt_set(file, &status, rename, (ULONG)size, (FILE_INFORMATION_CLASS)65);
  int error = result < 0 ? (int)nt_error(result) : 0;
  free(rename); return error;
}
static int supported_file(HANDLE file) {
  FILE_ATTRIBUTE_TAG_INFO attributes;
  FILE_STANDARD_INFO standard;
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard))) return (int)GetLastError();
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && !cloud_tag(attributes.ReparseTag))) return ERROR_REPARSE_TAG_INVALID;
  if (attributes.FileAttributes & (FILE_ATTRIBUTE_OFFLINE | 0x00400000UL)) return 0x20000007;
  if (attributes.FileAttributes & FILE_ATTRIBUTE_ENCRYPTED) return 0x20000002;
  if (standard.NumberOfLinks != 1) return 0x20000003;
  BYTE streams[65536] = {0}; IO_STATUS_BLOCK status;
  NTSTATUS code = nt_query(file, &status, streams, sizeof(streams), (FILE_INFORMATION_CLASS)22 /* FileStreamInformation */);
  if ((ULONG)code == 0x80000005UL || (ULONG)code == 0xc0000004UL) return 0x20000004;
  if (code < 0) return (int)nt_error(code);
  if (!status.Information) return 0;
  typedef struct { ULONG next, length; LARGE_INTEGER size, allocation; WCHAR name[1]; } Stream;
  Stream *stream = (Stream *)streams;
  if (stream->next || stream->length != 14 || memcmp(stream->name, L"::$DATA", 14)) return 0x20000004;
  return 0;
}
static int save_policy(Context *context, HANDLE original, PSECURITY_DESCRIPTOR *descriptor) {
  PSID owner = NULL, group = NULL; PACL dacl = NULL;
  int error = (int)GetSecurityInfo(original, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, &group, &dacl, NULL, descriptor);
  PSECURITY_DESCRIPTOR private_descriptor = NULL; wchar_t *sid = NULL;
  if (!error) error = current_user_security(&private_descriptor, &sid, 0);
  PSID current = NULL; BOOL defaulted = FALSE;
  if (!error && !GetSecurityDescriptorOwner(private_descriptor, &current, &defaulted)) error = (int)GetLastError();
  if (!error && (!owner || !EqualSid(owner, current))) error = 0x20000008;
  if (!error && !dacl) error = 0x20000009;
  HANDLE file = INVALID_HANDLE_VALUE;
  if (!error) {
    file = create_relative(context->record, L"original-security", GENERIC_WRITE | READ_CONTROL,
                            2, FILE_ATTRIBUTE_NORMAL, private_descriptor, FILE_SHARE_READ);
    if (file == INVALID_HANDLE_VALUE) error = (int)GetLastError();
  }
  if (!error) {
    DWORD size = GetSecurityDescriptorLength(*descriptor), written = 0;
    if (!WriteFile(file, *descriptor, size, &written, NULL) || written != size) error = (int)GetLastError();
    if (!error) error = flush_handle(file);
  }
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  if (private_descriptor) LocalFree(private_descriptor);
  if (sid) LocalFree(sid);
  return error;
}
static int set_recorded_dacl(HANDLE file, PSECURITY_DESCRIPTOR descriptor) {
  SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) return (int)GetLastError();
  /* The native setter preserves AUTO_INHERITED only with its set-only request bit. */
  if (!SetSecurityDescriptorControl(descriptor, SE_DACL_AUTO_INHERIT_REQ,
      control & SE_DACL_AUTO_INHERITED ? SE_DACL_AUTO_INHERIT_REQ : 0)) return (int)GetLastError();
  NTSTATUS result = nt_security(file, DACL_SECURITY_INFORMATION, descriptor);
  return result < 0 ? (int)nt_error(result) : 0;
}
static int restore_policy(Context *context, HANDLE original) {
  HANDLE file = open_relative(context->record, L"original-security", GENERIC_READ | READ_CONTROL, 0, FILE_SHARE_READ);
  if (file == INVALID_HANDLE_VALUE) return (int)GetLastError();
  LARGE_INTEGER size = {0}; DWORD received = 0;
  int error = private_security(file, SE_FILE_OBJECT, NULL);
  if (!error && (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 65536)) error = ERROR_INVALID_DATA;
  BYTE *descriptor = error ? NULL : malloc((size_t)size.QuadPart);
  if (!error && !descriptor) error = ERROR_NOT_ENOUGH_MEMORY;
  if (!error && (!ReadFile(file, descriptor, (DWORD)size.QuadPart, &received, NULL) || received != (DWORD)size.QuadPart ||
                 !IsValidSecurityDescriptor(descriptor))) error = ERROR_INVALID_DATA;
  if (!error) {
    PACL dacl = NULL; BOOL present, defaulted; SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
    if (!GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) || !present || !dacl ||
        !GetSecurityDescriptorControl(descriptor, &control, &revision)) error = ERROR_INVALID_DATA;
    else {
      error = set_recorded_dacl(original, descriptor);
    }
  }
  free(descriptor); CloseHandle(file); return error;
}
static int restrict_policy(HANDLE file) {
  FILE_ATTRIBUTE_TAG_INFO attributes;
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))) return (int)GetLastError();
  PSECURITY_DESCRIPTOR descriptor = NULL; wchar_t *sid = NULL;
  int error = current_user_security(&descriptor, &sid, !!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY));
  PACL dacl = NULL; BOOL present, defaulted;
  if (!error && !GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted)) error = (int)GetLastError();
  if (!error) error = (int)SetSecurityInfo(file, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, dacl, NULL);
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  return error;
}
static int available_child(HANDLE parent, const wchar_t *name) {
  wchar_t path[32768];
  DWORD length = GetFinalPathNameByHandleW(parent, path, 32768, VOLUME_NAME_DOS);
  size_t component = wcslen(name);
  if (!length || length + component + 2 >= 32768) return ERROR_FILENAME_EXCED_RANGE;
  if (path[length - 1] != L'\\') path[length++] = L'\\';
  memcpy(path + length, name, (component + 1) * sizeof(wchar_t));
  WIN32_FIND_DATAW data;
  HANDLE find = FindFirstFileW(path, &data);
  if (find == INVALID_HANDLE_VALUE) return (int)GetLastError();
  FindClose(find);
  return data.dwFileAttributes & (FILE_ATTRIBUTE_OFFLINE | 0x00040000UL | 0x00400000UL) ? 0x20000007 : 0;
}
static int windows_operation(Context *context, const char *operation, const char *source,
                            const char *destination, Entry *before, Entry *after_source,
                            Entry *after_destination, Flush *flush, int *applied) {
  wchar_t *from = wide(source), *to = wide(destination);
  if (!from || !to) { free(from); free(to); return ERROR_INVALID_NAME; }
  Entry parent = {0}, record = {0};
  int error = identify(context->parent, &parent);
  if (!error) error = identify(context->record, &record);
  int prepare = !strcmp(operation, "win-prepare") || !strcmp(operation, "win-prepare-create") ||
                !strcmp(operation, "win-prepare-delete");
  int recover = !strcmp(operation, "win-resume") || !strcmp(operation, "win-resume-stage") || !strcmp(operation, "win-resume-captured");
  if (prepare || recover) {
    if (transaction.original || transaction.stage) { error = ERROR_BUSY; goto done; }
    transaction.parent_id = parent; transaction.record_id = record;
    int creation = !strcmp(operation, "win-prepare-create") || !strcmp(operation, "win-resume-stage");
    if (!creation) {
      HANDLE original_parent = !strcmp(operation, "win-resume-captured") ? context->record : context->parent;
      transaction.captured = !strcmp(operation, "win-resume-captured");
      error = available_child(original_parent, from);
      if (error) goto done;
      transaction.original = open_relative(original_parent, from,
        GENERIC_READ | DELETE | WRITE_DAC | READ_CONTROL, 0, FILE_SHARE_READ);
      if (transaction.original == INVALID_HANDLE_VALUE) { transaction.original = NULL; error = (int)GetLastError(); goto done; }
      error = identify(transaction.original, &transaction.original_id);
      if (!error && ((strcmp(operation, "win-prepare-delete") && strcmp(operation, "win-resume") && strcmp(operation, "win-resume-captured")) || strcmp(transaction.original_id.type, "directory")))
        error = supported_file(transaction.original);
      if (!error) error = identify(transaction.original, &transaction.original_id);
      *before = transaction.original_id;
      if (error) goto done;
    }
    if (recover && transaction.captured) goto done;
    if (recover) {
      transaction.stage = open_relative(context->parent, to, GENERIC_READ | DELETE | READ_CONTROL,
        0, FILE_SHARE_READ);
      if (transaction.stage == INVALID_HANDLE_VALUE) { transaction.stage = NULL; error = (int)GetLastError(); goto done; }
      error = supported_file(transaction.stage);
      if (!error) error = identify(transaction.stage, &transaction.stage_id);
      *after_destination = transaction.stage_id;
      goto done;
    }
    PSECURITY_DESCRIPTOR descriptor = NULL;
    error = creation ? inherited_user_security(&descriptor) : save_policy(context, transaction.original, &descriptor);
    if (!error && strcmp(operation, "win-prepare-delete")) {
      SECURITY_DESCRIPTOR_CONTROL original_control = 0; DWORD revision = 0;
      DWORD stage_attributes = FILE_ATTRIBUTE_NORMAL;
      if (transaction.original) {
        FILE_BASIC_INFO basic;
        if (!GetFileInformationByHandleEx(transaction.original, FileBasicInfo, &basic, sizeof(basic))) error = (int)GetLastError();
        else {
          stage_attributes = basic.FileAttributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM |
            FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED);
          if (!stage_attributes) stage_attributes = FILE_ATTRIBUTE_NORMAL;
        }
      }
      if (!error && transaction.original && (!GetSecurityDescriptorControl(descriptor, &original_control, &revision) ||
          !SetSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED))) error = (int)GetLastError();
      if (!error) transaction.stage = create_relative(context->parent, to,
        GENERIC_READ | GENERIC_WRITE | DELETE | WRITE_DAC | FILE_WRITE_ATTRIBUTES | READ_CONTROL,
        2, stage_attributes, descriptor, FILE_SHARE_READ);
      if (transaction.stage == INVALID_HANDLE_VALUE) { transaction.stage = NULL; error = (int)GetLastError(); }
      if (transaction.stage) *applied = -1;
      if (!error && transaction.original) {
        if (!SetSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, original_control & SE_DACL_PROTECTED)) error = (int)GetLastError();
        else {
          error = set_recorded_dacl(transaction.stage, descriptor);
        }
      }
      if (!error) error = supported_file(transaction.stage);
      HANDLE payload = INVALID_HANDLE_VALUE;
      if (!error) {
        payload = open_relative(context->record, L"payload", GENERIC_READ, 0, FILE_SHARE_READ);
        if (payload == INVALID_HANDLE_VALUE) error = (int)GetLastError();
      }
      BYTE buffer[65536]; DWORD received = 0, written = 0;
      while (!error) {
        if (!ReadFile(payload, buffer, sizeof(buffer), &received, NULL)) { error = (int)GetLastError(); break; }
        if (!received) break;
        if (!WriteFile(transaction.stage, buffer, received, &written, NULL) || written != received) error = ERROR_WRITE_FAULT;
      }
      if (payload != INVALID_HANDLE_VALUE) CloseHandle(payload);
      FILE_BASIC_INFO attributes;
      if (!error && transaction.original) {
        if (!GetFileInformationByHandleEx(transaction.original, FileBasicInfo, &attributes, sizeof(attributes))) error = (int)GetLastError();
        else {
          DWORD flags = attributes.FileAttributes & ~(FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE | 0x00400000UL);
          memset(&attributes, 0, sizeof(attributes));
          attributes.FileAttributes = flags ? flags : FILE_ATTRIBUTE_NORMAL;
          if (!SetFileInformationByHandle(transaction.stage, FileBasicInfo, &attributes, sizeof(attributes))) error = (int)GetLastError();
        }
      }
      if (!error) error = flush_handle(transaction.stage);
      if (!error) error = identify(transaction.stage, &transaction.stage_id);
      *after_destination = transaction.stage_id;
    }
    if (descriptor) LocalFree(descriptor);
    if (!error) { *applied = 1; *after_source = transaction.original_id; }
    goto done;
  }
  if ((strcmp(operation, "win-install") && (strcmp(parent.dev, transaction.parent_id.dev) ||
        strcmp(parent.ino, transaction.parent_id.ino))) ||
      strcmp(record.dev, transaction.record_id.dev) || strcmp(record.ino, transaction.record_id.ino)) {
    error = ERROR_FILE_INVALID; goto done;
  }
  if (!strcmp(operation, "win-release")) { close_transaction(); goto done; }
  if (!strcmp(operation, "win-restore-policy")) {
    if (!transaction.original || transaction.captured) { error = ERROR_INVALID_HANDLE; goto done; }
    *before = transaction.original_id; *applied = -1;
    error = restore_policy(context, transaction.original);
    if (!error) *applied = 1;
  } else if (!strcmp(operation, "win-restrict")) {
    if (!transaction.original) { error = ERROR_INVALID_HANDLE; goto done; }
    *before = transaction.original_id; *applied = -1;
    error = restrict_policy(transaction.original);
    if (!error) *applied = 1;
  } else if (!strcmp(operation, "win-capture")) {
    if (!transaction.original || transaction.captured) { error = ERROR_INVALID_HANDLE; goto done; }
    *before = transaction.original_id;
    error = private_security(transaction.original, SE_FILE_OBJECT, NULL);
    if (!error) error = rename_handle(transaction.original, context->record, to);
    if (!error) { transaction.captured = 1; *applied = 1; *after_destination = transaction.original_id; }
  } else if (!strcmp(operation, "win-remove-captured")) {
    if (!transaction.original || !transaction.captured || strcmp(transaction.original_id.type, "directory")) { error = ERROR_INVALID_HANDLE; goto done; }
    FILE_DISPOSITION_INFO disposition = { TRUE };
    if (!SetFileInformationByHandle(transaction.original, FileDispositionInfo, &disposition, sizeof(disposition))) error = (int)GetLastError();
    else { *applied = 1; CloseHandle(transaction.original); transaction.original = NULL; }
  } else if (!strcmp(operation, "win-return-captured")) {
    if (!transaction.original || !transaction.captured) { error = ERROR_INVALID_HANDLE; goto done; }
    error = rename_handle(transaction.original, context->parent, to);
    if (!error) { transaction.captured = 0; *applied = 1; *after_destination = transaction.original_id; }
  } else if (!strcmp(operation, "win-install")) {
    if (!transaction.stage) { error = ERROR_INVALID_HANDLE; goto done; }
    *before = transaction.stage_id;
    error = rename_handle(transaction.stage, context->parent, to);
    if (!error) { *applied = 1; *after_destination = transaction.stage_id; }
  } else error = ERROR_INVALID_PARAMETER;
  if (*applied) {
    flush->source_directory = flush_handle(context->parent);
    flush->destination_directory = flush_handle(context->record);
  }
done:
  free(from); free(to); return error;
}

static int qualified_volume(HANDLE folder) {
  wchar_t filesystem[64]; DWORD serial, maximum, flags;
  if (!GetVolumeInformationByHandleW(folder, NULL, 0, &serial, &maximum, &flags, filesystem, 64))
    return (int)GetLastError();
  if (_wcsicmp(filesystem, L"NTFS")) return 0x20000006;
  typedef NTSTATUS (WINAPI *Version)(PRTL_OSVERSIONINFOW);
  FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  Version version = NULL; memcpy(&version, &address, sizeof(version));
  RTL_OSVERSIONINFOW info; memset(&info, 0, sizeof(info)); info.dwOSVersionInfoSize = sizeof(info);
  if (!version || version(&info) < 0 || info.dwMajorVersion < 10 || info.dwBuildNumber < 17763)
    return ERROR_OLD_WIN_VERSION;
  return 0;
}
int platform_windows_main(int argc, char **argv) {
#ifdef SCIENT_PUBLICATION_PROBE
  if (argc == 4 && !strcmp(argv[2], "drive-mask")) {
    printf("{\"mask\":%lu}\n", (unsigned long)GetLogicalDrives()); return 0;
  }
  if (argc == 4 && (!strcmp(argv[2], "add-account") || !strcmp(argv[2], "delete-account"))) {
    wchar_t account[256], password[256];
    GetEnvironmentVariableW(L"SCIENT_TEST_ACCOUNT", account, 256);
    GetEnvironmentVariableW(L"SCIENT_TEST_PASSWORD", password, 256);
    USER_INFO_1 user = {0}; user.usri1_name = account; user.usri1_password = password;
    user.usri1_priv = USER_PRIV_USER; user.usri1_flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD;
    DWORD parameter = 0;
    NET_API_STATUS error = !strcmp(argv[2], "add-account") ? NetUserAdd(NULL, 1, (LPBYTE)&user, &parameter) : NetUserDel(NULL, account);
    printf("{\"code\":%lu}\n", (unsigned long)error); return 0;
  }
  if (argc == 4 && (!strcmp(argv[2], "default-owner") || !strcmp(argv[2], "default-owner-admin"))) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)strtoul(argv[3], NULL, 10));
    HANDLE token = NULL; DWORD error = 0, length = 0;
    TOKEN_USER *user = NULL;
    if (!process || !OpenProcessToken(process, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &token)) error = GetLastError();
    if (!error) {
      GetTokenInformation(token, TokenUser, NULL, 0, &length);
      user = malloc(length);
      if (!user) error = ERROR_NOT_ENOUGH_MEMORY;
      else if (!GetTokenInformation(token, TokenUser, user, length, &length)) error = GetLastError();
      else {
        BYTE administrators[SECURITY_MAX_SID_SIZE]; DWORD size = sizeof(administrators);
        TOKEN_OWNER owner = { user->User.Sid };
        if (!strcmp(argv[2], "default-owner-admin")) {
          if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, administrators, &size)) error = GetLastError();
          else owner.Owner = administrators;
        }
        if (!error && !SetTokenInformation(token, TokenOwner, &owner, sizeof(owner))) error = GetLastError();
      }
    }
    free(user); if (token) CloseHandle(token); if (process) CloseHandle(process);
    printf("{\"code\":%lu}\n", (unsigned long)error); return 0;
  }
  if (argc == 4 && (!strcmp(argv[2], "register-sync-root") || !strcmp(argv[2], "unregister-sync-root"))) {
    HMODULE library = LoadLibraryW(L"cldapi.dll");
    typedef HRESULT (WINAPI *Register)(LPCWSTR, const CF_SYNC_REGISTRATION *, const CF_SYNC_POLICIES *, CF_REGISTER_FLAGS);
    typedef HRESULT (WINAPI *Unregister)(LPCWSTR);
    Register registration = NULL; Unregister unregistration = NULL;
    FARPROC address = library ? GetProcAddress(library, "CfRegisterSyncRoot") : NULL; memcpy(&registration, &address, sizeof(registration));
    address = library ? GetProcAddress(library, "CfUnregisterSyncRoot") : NULL; memcpy(&unregistration, &address, sizeof(unregistration));
    wchar_t *path = wide_path(argv[3]); HRESULT result = E_NOTIMPL;
    if (registration && unregistration && path) {
      CF_SYNC_REGISTRATION data = {0}; data.StructSize = sizeof(data);
      data.ProviderName = L"Scient file qualification"; data.ProviderVersion = L"1";
      CF_SYNC_POLICIES policies = {0}; policies.StructSize = sizeof(policies);
      policies.Hydration.Primary = CF_HYDRATION_POLICY_FULL;
      policies.Population.Primary = CF_POPULATION_POLICY_FULL;
      result = !strcmp(argv[2], "register-sync-root") ? registration(path, &data, &policies, CF_REGISTER_FLAG_NONE) : unregistration(path);
    }
    printf("{\"code\":%lu}\n", (unsigned long)HRESULT_CODE(result));
    free(path); if (library) FreeLibrary(library); return 0;
  }
  if (argc == 4 && !strcmp(argv[2], "terminate")) {
    HANDLE process = OpenProcess(PROCESS_TERMINATE, FALSE, (DWORD)strtoul(argv[3], NULL, 10));
    if (!process) return 71;
    int result = TerminateProcess(process, 73) ? 0 : 71;
    CloseHandle(process); return result;
  }
  if (argc == 4 && !strcmp(argv[2], "hold-write")) {
    wchar_t *path = wide_path(argv[3]);
    HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    free(path);
    if (file == INVALID_HANDLE_VALUE) return 71;
    printf("HELD\n"); fflush(stdout); getchar(); CloseHandle(file); return 0;
  }
  if (argc == 4 && !strcmp(argv[2], "hold-map")) {
    wchar_t *path = wide_path(argv[3]);
    HANDLE file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    free(path);
    if (file == INVALID_HANDLE_VALUE) return 71;
    HANDLE mapping = CreateFileMappingW(file, NULL, PAGE_READWRITE, 0, 0, NULL);
    void *view = mapping ? MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 0) : NULL;
    CloseHandle(file);
    if (!view) { if (mapping) CloseHandle(mapping); return 71; }
    printf("HELD\n"); fflush(stdout); getchar();
    UnmapViewOfFile(view); CloseHandle(mapping); return 0;
  }
  if (argc == 4 && (!strcmp(argv[2], "as-account") || !strcmp(argv[2], "as-account-cloud"))) {
    wchar_t user[256], password[256];
    GetEnvironmentVariableW(L"SCIENT_TEST_ACCOUNT", user, 256);
    GetEnvironmentVariableW(L"SCIENT_TEST_PASSWORD", password, 256);
    HANDLE token = NULL; DWORD error = 0;
    if (!LogonUserW(user, L".", password, LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT, &token) ||
        !ImpersonateLoggedOnUser(token)) error = GetLastError();
    wchar_t *path = wide_path(argv[3]);
    HANDLE file = INVALID_HANDLE_VALUE;
    if (!error) {
      file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
      if (file == INVALID_HANDLE_VALUE) error = GetLastError();
      else if (!strcmp(argv[2], "as-account-cloud")) {
        error = (DWORD)cloud_managed(file);
        HMODULE filters = LoadLibraryW(L"fltlib.dll");
        typedef HRESULT (WINAPI *FirstInstance)(LPCWSTR, INSTANCE_INFORMATION_CLASS, LPVOID, DWORD, LPDWORD, LPHANDLE);
        typedef HRESULT (WINAPI *CloseInstance)(HANDLE);
        FirstInstance first = NULL; CloseInstance close = NULL;
        FARPROC address = filters ? GetProcAddress(filters, "FilterInstanceFindFirst") : NULL; memcpy(&first, &address, sizeof(first));
        address = filters ? GetProcAddress(filters, "FilterInstanceFindClose") : NULL; memcpy(&close, &address, sizeof(close));
        union { ULONGLONG aligned; BYTE bytes[65536]; } buffer; DWORD returned = 0; HANDLE search = INVALID_HANDLE_VALUE;
        if (first && close) {
          probe_instance_status = first(L"CldFlt", InstanceFullInformation, buffer.bytes, sizeof(buffer.bytes), &returned, &search);
          if (search != INVALID_HANDLE_VALUE) close(search);
        }
        if (filters) FreeLibrary(filters);
      }
    }
    RevertToSelf(); if (token) CloseHandle(token);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    free(path); printf("{\"code\":%lu,\"filterCode\":%lu,\"pathCode\":%lu,\"instanceCode\":%lu}\n", (unsigned long)error,
      (unsigned long)probe_filter_status, (unsigned long)probe_path_error, (unsigned long)probe_instance_status); return 0;
  }
#endif

  if (argc != 4 || (strcmp(argv[2], "info") && strcmp(argv[2], "flags") && strcmp(argv[2], "private") && strcmp(argv[2], "security"))) return 64;
  wchar_t *path = wide_path(argv[3]);
  if (!path) return 71;
  WIN32_FIND_DATAW data; memset(&data, 0, sizeof(data));
  HANDLE find = FindFirstFileW(path, &data);
  int error = find == INVALID_HANDLE_VALUE ? (int)GetLastError() : 0;
  if (find != INVALID_HANDLE_VALUE) FindClose(find);
  if ((wcslen(path) == 3 && path[1] == L':') || (wcslen(path) == 7 && path[5] == L':')) {
    data.dwFileAttributes = GetFileAttributesW(path);
    error = data.dwFileAttributes == INVALID_FILE_ATTRIBUTES ? (int)GetLastError() : 0;
    if (!error) data.dwFileAttributes &= ~0x00040000UL; /* Root metadata is not an enumeration result. */
  }
  if (!strcmp(argv[2], "flags")) {
    printf("{\"code\":%d,\"flags\":%lu}\n", error, (unsigned long)data.dwFileAttributes);
    free(path); return 0;
  }
  Context *context = NULL; HANDLE file = INVALID_HANDLE_VALUE; Entry entry = {0};
  int managed = 0;
  if (!error) {
    if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      context = platform_bind_parent(argv[3], ".", &error);
      if (context) file = context->parent;
    } else {
      char *parent = _strdup(argv[3]); char *separator = strrchr(parent, '\\');
      char *slash = strrchr(parent, '/');
      if (!separator || (slash && slash > separator)) separator = slash;
      if (!separator) error = ERROR_INVALID_NAME;
      else {
        char *basename = _strdup(separator + 1);
        if (!basename) { free(parent); free(path); return 71; }
        if (separator == parent + 2 && parent[1] == ':') separator[1] = 0;
        else *separator = 0;
        context = platform_bind_parent(parent, ".", &error);
        if (context) {
          wchar_t *name = wide(basename);
          file = open_relative(context->parent, name, FILE_READ_ATTRIBUTES | READ_CONTROL,
            0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
          free(name);
          if (file == INVALID_HANDLE_VALUE) error = (int)GetLastError();
        }
        free(basename);
      }
      free(parent);
    }
  }
  FILE_BASIC_INFO basic = {0};
  if (!error) error = identify(file, &entry);
  if (!error && !GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic))) error = (int)GetLastError();
  if (!error && strcmp(entry.type, "file") && strcmp(entry.type, "directory")) error = ERROR_REPARSE_TAG_INVALID;
  if (!error) error = qualified_volume(file);
  if (!error && !strcmp(argv[2], "private")) {
    int cloud = cloud_managed(file);
    if (cloud == 0x20000001) managed = 1;
    else if (cloud) error = cloud;
  }
  if (!error && !strcmp(argv[2], "private")) error = private_security(file, SE_FILE_OBJECT, NULL);
  if (!error && !strcmp(argv[2], "security")) {
    PSECURITY_DESCRIPTOR descriptor = NULL; PSID owner, group; PACL dacl;
    error = (int)GetSecurityInfo(file, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, &group, &dacl, NULL, &descriptor);
    wchar_t *text = NULL;
    if (!error && !ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1,
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &text, NULL)) error = (int)GetLastError();
    printf("{\"code\":%d,\"security\":\"%ls\"}\n", error, text ? text : L"");
    if (text) LocalFree(text);
    if (descriptor) LocalFree(descriptor);
    if (file != context->parent) CloseHandle(file);
    platform_close(context); free(path); return 0;
  }
  printf("{\"code\":%d,\"flags\":%lu,\"syncManaged\":%s,\"identity\":", error,
    (unsigned long)data.dwFileAttributes, managed ? "true" : "false");
  if (!error) printf("{\"dev\":\"%s\",\"ino\":\"%s\",\"type\":\"%s\"}", entry.dev, entry.ino, entry.type);
  else printf("null");
  if (!error) printf(",\"changeTime\":\"%lld\"", (long long)basic.ChangeTime.QuadPart);
  printf("}\n");
  if (file != INVALID_HANDLE_VALUE && context && file != context->parent) CloseHandle(file);
  if (context) platform_close(context);
  free(path); return 0;
}

int platform_windows_flags(int argc, char **argv) {
  if (argc < 2 || argc > 258) return 64;
  printf("[");
  for (int i = 2; i < argc; ++i) {
    wchar_t *path = wide_path(argv[i]);
    DWORD flags = 0, error = ERROR_INVALID_NAME;
    if (path) {
      WIN32_FIND_DATAW data;
      HANDLE find = FindFirstFileW(path, &data);
      error = find == INVALID_HANDLE_VALUE ? GetLastError() : 0;
      if (find != INVALID_HANDLE_VALUE) { flags = data.dwFileAttributes; FindClose(find); }
      if ((wcslen(path) == 3 && path[1] == L':') || (wcslen(path) == 7 && path[5] == L':')) {
        flags = GetFileAttributesW(path);
        error = flags == INVALID_FILE_ATTRIBUTES ? GetLastError() : 0;
        if (!error) flags &= ~0x00040000UL; /* This bit denotes EA outside enumeration. */
      }
      free(path);
    }
    if (i > 2) printf(",");
    if (!error) printf("%lu", (unsigned long)flags);
    else printf("%d", error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_DIRECTORY ? 0 : -1);
  }
  printf("]\n"); return 0;
}
