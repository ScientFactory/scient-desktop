# This is a dedicated preview-only build, not a replacement system libarchive.
set(source "${SOURCE_DIR}/libarchive/archive_read_support_format_zip.c")
file(SHA256 "${source}" digest)
if(NOT digest STREQUAL "9a1fe849186a29c294a3dcdfc548053c705bc26e91f506e1c8808a5160231724")
  message(FATAL_ERROR "Unexpected libarchive ZIP reader source; review the SCIC policy patch")
endif()
file(READ "${source}" content)
string(REPLACE "struct zip {" "struct zip {\n\tunsigned int scic_entry_count;" content "${content}")
set(anchor "\tversion = p[4];")
set(policy [=[
	/* Scient preview policy v1. Check full-width method BEFORE narrowing it
	 * or processing extra fields/symlinks, which can instantiate a decoder. */
	unsigned int scic_method = archive_le16dec(p + 8);
	if ((scic_method != 0 && scic_method != 8) ||
	    (zip->scic_entry_count == 0 &&
	      (scic_method != 0 || a->filter->position != 0))) {
		archive_set_error(&a->archive, ARCHIVE_ERRNO_FILE_FORMAT,
		    "Unsupported SCIC ZIP compression or first entry");
		return ARCHIVE_FATAL;
	}
	if (++zip->scic_entry_count > 10000 ||
	    (archive_le16dec(p + 6) & 0x41) != 0) {
		archive_set_error(&a->archive, ARCHIVE_ERRNO_FILE_FORMAT,
		    "Unsafe SCIC ZIP entry");
		return ARCHIVE_FATAL;
	}
	version = p[4];]=])
string(REPLACE "${anchor}" "${policy}" content "${content}")
# The caller requires this symbol so accidentally linking an unpatched system
# reader fails at link time, rather than silently removing the security gate.
string(APPEND content "\nint scic_archive_policy_version(void);\nint scic_archive_policy_version(void) { return 1; }\n")
file(WRITE "${source}" "${content}")
