import { describe, expect, it } from "@effect/vitest";

import { EXPORT_FILE_NAME_MAX_BYTES, exportFileName } from "./exportFileName.ts";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("export file names", () => {
  it("removes path and reserved characters", () => {
    expect(exportFileName('Long / study: "results"?', ".md")).toBe("Long study results.md");
    expect(exportFileName("  ...  ", ".zip")).toBe("Conversation.zip");
  });

  it("bounds the whole name by encoded bytes on code-point boundaries", () => {
    const cjk = "研究結果".repeat(23);
    const name = exportFileName(cjk, ".zip");
    expect(bytes(name)).toBeLessThanOrEqual(EXPORT_FILE_NAME_MAX_BYTES);
    expect(name.endsWith(".zip")).toBe(true);
    expect(name.slice(0, -4)).toBe(cjk.slice(0, name.length - 4));

    const emoji = exportFileName("🧪".repeat(80), ".md");
    expect(bytes(emoji)).toBeLessThanOrEqual(EXPORT_FILE_NAME_MAX_BYTES);
    expect(Array.from(emoji.slice(0, -3)).every((character) => character === "🧪")).toBe(true);
  });

  it("avoids Windows device names and trailing dots or spaces", () => {
    for (const title of ["CON", "prn", "Aux", "NUL", "com1", "LPT9", "con.backup", "NUL . notes"]) {
      const name = exportFileName(title, ".md");
      expect(name.startsWith("_")).toBe(true);
    }
    expect(exportFileName("Console log", ".md")).toBe("Console log.md");
    expect(exportFileName("COM10", ".md")).toBe("COM10.md");
    const padded = exportFileName(`${"a".repeat(194)}. .b`, ".md");
    expect(padded).toBe(`${"a".repeat(194)}.md`);
  });
});
