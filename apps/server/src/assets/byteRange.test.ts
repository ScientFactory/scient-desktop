import { describe, expect, it } from "vite-plus/test";

import { parseSingleByteRange } from "./byteRange.ts";

describe("parseSingleByteRange", () => {
  it.each([
    ["bytes=0-99", 1_000, { start: 0, end: 99 }],
    ["bytes=900-", 1_000, { start: 900, end: 999 }],
    ["bytes=-100", 1_000, { start: 900, end: 999 }],
    ["bytes=900-1200", 1_000, { start: 900, end: 999 }],
    ["BYTES=20-29", 1_000, { start: 20, end: 29 }],
  ] as const)("parses %s", (header, size, expected) => {
    expect(parseSingleByteRange(header, size)).toEqual(expected);
  });

  it.each(["bytes=1000-", "bytes=500-400", "bytes=-0"])(
    "rejects unsatisfiable range %s",
    (header) => {
      expect(parseSingleByteRange(header, 1_000)).toBe("unsatisfiable");
    },
  );

  it.each(["items=0-1", "bytes=", "bytes=0-1,4-5", "bytes=a-b"])(
    "ignores unsupported range %s",
    (header) => {
      expect(parseSingleByteRange(header, 1_000)).toBe("unsupported");
    },
  );
});
