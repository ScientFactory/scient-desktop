import { describe, expect, it } from "vite-plus/test";

import { decodeEnvironmentTextPreview } from "./environmentTextPreview";

describe("environment text preview decoding", () => {
  it("omits an incomplete trailing UTF-8 character from a bounded preview", () => {
    const partialEuro = new Uint8Array([0x41, 0xe2, 0x82]);
    expect(decodeEnvironmentTextPreview(partialEuro.buffer, "utf-8", true)).toBe("A");
    expect(() => decodeEnvironmentTextPreview(partialEuro.buffer, "utf-8", false)).toThrow();
  });

  it("omits an incomplete trailing UTF-16 code unit from a bounded preview", () => {
    const incompleteUtf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]);
    expect(decodeEnvironmentTextPreview(incompleteUtf16.buffer, "utf-16le", true)).toBe("A");
  });

  it("strips a byte-order mark from complete text", () => {
    const utf8WithBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(decodeEnvironmentTextPreview(utf8WithBom.buffer, "utf-8", false)).toBe("A");
  });
});
