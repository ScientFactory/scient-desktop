/** Longest file name, in UTF-8 bytes, that every desktop file system accepts (most allow 255). */
export const EXPORT_FILE_NAME_MAX_BYTES = 200;

const encoder = new TextEncoder();

/** Keeps whole code points while the encoded text fits in `maxBytes`. */
function truncateUtf8(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const codePoint of text) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}

/**
 * A file name derived from a conversation title that desktop file systems
 * accept: no path or reserved characters, no leading or trailing dots, and at
 * most `EXPORT_FILE_NAME_MAX_BYTES` bytes including `extension` (e.g. ".md").
 */
export function exportFileName(title: string, extension: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+|\.+$/gu, "");
  const budget = EXPORT_FILE_NAME_MAX_BYTES - encoder.encode(extension).byteLength;
  const stem = truncateUtf8(cleaned, budget).trim().replace(/\.+$/u, "");
  return `${stem.length > 0 ? stem : "Conversation"}${extension}`;
}
