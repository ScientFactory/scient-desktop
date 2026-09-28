/**
 * Whether image bytes begin the way their media type says they must. The
 * check is only the file signature: it catches a HEIC photo or a text file
 * named `.jpg`, or an empty file, before the capture copies it. Bytes that
 * pass can still fail to decode; the document page shows those as
 * placeholders.
 */

const ascii = (bytes: Uint8Array, start: number, text: string) =>
  bytes.byteLength >= start + text.length &&
  [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0));

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>) =>
  bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);

/** An ISO base media `ftyp` box naming one of `brands` as its major or a compatible brand. */
function hasFileTypeBrand(bytes: Uint8Array, brands: ReadonlyArray<string>): boolean {
  if (!ascii(bytes, 4, "ftyp")) return false;
  const declared = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const end = Math.min(bytes.byteLength, declared >= 16 ? declared : 16, 256);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    // Offset 12 is the minor version, not a brand.
    if (offset === 12) continue;
    if (brands.some((brand) => ascii(bytes, offset, brand))) return true;
  }
  return false;
}

const SVG_PROBE_BYTES = 4_096;

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, SVG_PROBE_BYTES))
    .replace(/^﻿/u, "");
  return /<svg[\s>/]/iu.test(head);
}

const SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/gif": (bytes) => ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"),
  "image/webp": (bytes) => ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP"),
  "image/avif": (bytes) => hasFileTypeBrand(bytes, ["avif", "avis"]),
  "image/bmp": (bytes) => ascii(bytes, 0, "BM"),
  "image/svg+xml": looksLikeSvg,
};

const LABELS: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/avif": "AVIF",
  "image/bmp": "BMP",
  "image/svg+xml": "SVG",
};

/** True when `bytes` carry the signature of `mediaType`; unknown media types never match. */
export function hasImageSignature(bytes: Uint8Array, mediaType: string): boolean {
  return SIGNATURES[mediaType.toLowerCase()]?.(bytes) ?? false;
}

/** The format's short name for messages, such as "PNG". */
export function imageFormatLabel(mediaType: string): string {
  return LABELS[mediaType.toLowerCase()] ?? "image";
}
