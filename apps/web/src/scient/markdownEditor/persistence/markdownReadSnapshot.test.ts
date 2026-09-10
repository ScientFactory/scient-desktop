import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MarkdownReadSnapshotError, normalizeMarkdownReadSnapshot } from "./markdownReadSnapshot";

function serverRead(bytes: Uint8Array): ProjectReadFileResult {
  return {
    relativePath: "notes.md",
    contents: new TextDecoder("utf-8").decode(bytes),
    revision: `sha256:${bytesToHex(sha256(bytes))}`,
    byteLength: bytes.byteLength,
    truncated: false,
  };
}

describe("editable Markdown read byte fidelity", () => {
  it.each(["", "# שלום 😀\r\nCafé and café\r\n", "text with a real � character"])(
    "preserves complete canonical UTF-8 source %j",
    (source) => {
      const snapshot = serverRead(new TextEncoder().encode(source));
      expect(normalizeMarkdownReadSnapshot(snapshot)).toBe(snapshot);
      expect(normalizeMarkdownReadSnapshot(snapshot).contents).toBe(source);
    },
  );

  it.each(["\uFEFF", "\uFEFF# שלום 😀\r\n", "\uFEFF\uFEFF# Two BOMs\n"])(
    "restores a decoder-stripped BOM only when the raw revision proves it: %j",
    (source) => {
      const snapshot = serverRead(new TextEncoder().encode(source));
      expect(snapshot.contents).toBe(source.slice(1));
      expect(normalizeMarkdownReadSnapshot(snapshot)).toEqual({ ...snapshot, contents: source });
    },
  );

  it.each([[0xff], [0xe1, 0x80], [0xf0, 0x90, 0x80]])(
    "rejects lossy UTF-8 decoding even when decoded length can match raw length: %j",
    (...bytes) => {
      const snapshot = serverRead(Uint8Array.from(bytes));
      expect(snapshot.contents).toBe("�");
      expect(() => normalizeMarkdownReadSnapshot(snapshot)).toThrow(MarkdownReadSnapshotError);
      expect(() => normalizeMarkdownReadSnapshot(snapshot)).toThrow("original bytes");
    },
  );

  it("rejects a short read whose prefix hash matches but whose complete size does not", () => {
    const snapshot = serverRead(new TextEncoder().encode("prefix"));
    expect(() =>
      normalizeMarkdownReadSnapshot({ ...snapshot, byteLength: snapshot.byteLength + 5 }),
    ).toThrow("complete file could not be read");
  });

  it("does not treat arbitrary revision mismatches as permission to add a BOM", () => {
    const snapshot = serverRead(new TextEncoder().encode("# Before\n"));
    expect(() => normalizeMarkdownReadSnapshot({ ...snapshot, contents: "# After\n" })).toThrow(
      "original bytes",
    );
  });

  it("leaves already non-editable previews to their existing structural guards", () => {
    const snapshot = serverRead(new TextEncoder().encode("prefix"));
    const truncated = { ...snapshot, byteLength: 2_000_000, truncated: true };
    const readOnly = { ...snapshot, readOnly: true };
    expect(normalizeMarkdownReadSnapshot(truncated)).toBe(truncated);
    expect(normalizeMarkdownReadSnapshot(readOnly)).toBe(readOnly);
  });
});
