#ifndef SCIENT_SCIC_PREVIEW_H
#define SCIENT_SCIC_PREVIEW_H

#ifdef __cplusplus
extern "C" {
#endif

/* Returns 0 on success. Both output buffers are allocated by the library.
   The caller must release them with scic_preview_free. No archive member is
   extracted to the filesystem. The returned text is UTF-8. */
int scic_preview_read(const char *path_utf8, char **text_utf8, char **error_utf8);
typedef long long (*scic_preview_read_callback)(void *context, void *buffer, unsigned long length);
typedef long long (*scic_preview_skip_callback)(void *context, long long length);
/* For OS-provided streams such as Explorer's IStream. `length` is the source
   byte count; callbacks must return negative on failure. */
int scic_preview_read_stream(void *context, long long length,
                             scic_preview_read_callback read_callback,
                             scic_preview_skip_callback skip_callback,
                             char **text_utf8, char **error_utf8);
void scic_preview_free(char *value);

#ifdef __cplusplus
}
#endif
#endif
