import type { EnvironmentFileTextEncoding } from "@t3tools/contracts";

export const ENVIRONMENT_TEXT_PREVIEW_BYTE_LIMIT = 2 * 1_024 * 1_024;

/**
 * Decode a bounded text preview without manufacturing a replacement character
 * when the range ends inside a UTF-8 or UTF-16 code unit. A complete response
 * remains strict so unexpected corruption is surfaced instead of hidden.
 */
export function decodeEnvironmentTextPreview(
  bytes: ArrayBuffer,
  encoding: EnvironmentFileTextEncoding,
  truncated: boolean,
): string {
  const decoder = new TextDecoder(encoding, { fatal: true });
  const decoded = decoder.decode(bytes, { stream: truncated });
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}
