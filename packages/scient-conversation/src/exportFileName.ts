import { truncateUtf8 } from "./boundedText.ts";

/** Longest file name, in UTF-8 bytes, that every desktop file system accepts (most allow 255). */
export const EXPORT_FILE_NAME_MAX_BYTES = 200;

const encoder = new TextEncoder();

/** Device names Windows reserves whatever the extension: `CON`, `CON.md`, `com1.tar.gz`. */
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

/**
 * A file name derived from a conversation title that desktop file systems
 * accept: no path or reserved characters, no leading dots, no trailing dots or
 * spaces, no Windows device name, and at most `EXPORT_FILE_NAME_MAX_BYTES`
 * bytes including `extension` (e.g. ".md").
 */
export function exportFileName(title: string, extension: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+|\.+$/gu, "");
  // Windows reads everything before the first dot as the device name.
  const unreserved = WINDOWS_RESERVED_STEM.test(cleaned.split(".")[0]!.trim())
    ? `_${cleaned}`
    : cleaned;
  const budget = EXPORT_FILE_NAME_MAX_BYTES - encoder.encode(extension).byteLength;
  const stem = truncateUtf8(unreserved, budget).replace(/[\s.]+$/u, "");
  return `${stem.length > 0 ? stem : "Conversation"}${extension}`;
}
