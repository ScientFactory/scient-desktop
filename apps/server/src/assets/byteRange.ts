export type ByteRange = { readonly start: number; readonly end: number };

export type ParsedByteRange = ByteRange | "unsatisfiable" | "unsupported";

function parseSafeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parses the single byte ranges PDF.js requests. Multi-range responses are
 * deliberately unsupported: returning the complete file is valid HTTP and
 * avoids a multipart response path the reader does not need.
 */
export function parseSingleByteRange(header: string, fileSize: number): ParsedByteRange {
  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return "unsupported";

  const rangeValue = value.slice(6).trim();
  if (rangeValue.length === 0 || rangeValue.includes(",")) return "unsupported";

  const separatorIndex = rangeValue.indexOf("-");
  if (separatorIndex < 0) return "unsupported";

  const startPart = rangeValue.slice(0, separatorIndex).trim();
  const endPart = rangeValue.slice(separatorIndex + 1).trim();
  if (startPart === "" && endPart === "") return "unsupported";

  if (startPart === "") {
    const suffixLength = parseSafeInteger(endPart);
    if (suffixLength === null) return "unsupported";
    if (suffixLength === 0 || fileSize === 0) return "unsatisfiable";
    return {
      start: Math.max(fileSize - suffixLength, 0),
      end: fileSize - 1,
    };
  }

  const start = parseSafeInteger(startPart);
  if (start === null) return "unsupported";
  if (start >= fileSize) return "unsatisfiable";

  if (endPart === "") {
    return { start, end: fileSize - 1 };
  }

  const end = parseSafeInteger(endPart);
  if (end === null) return "unsupported";
  if (start > end) return "unsatisfiable";

  return { start, end: Math.min(end, fileSize - 1) };
}
