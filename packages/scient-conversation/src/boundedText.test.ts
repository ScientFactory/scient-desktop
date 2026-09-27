import { describe, expect, it } from "@effect/vitest";

import { boundItems, boundText } from "./boundedText.ts";

const BOUNDS = { headLines: 2, tailLines: 1, headChars: 20, tailChars: 10 };

describe("bounded text", () => {
  it("keeps short text unchanged", () => {
    expect(boundText("a\r\nb", BOUNDS)).toEqual({ text: "a\nb", omittedLines: 0, omittedChars: 0 });
  });

  it("keeps the head and tail lines and counts the omitted middle", () => {
    expect(boundText("1\n2\n3\n4\n5\n6", BOUNDS)).toEqual({
      text: "1\n2\n[… 3 lines omitted …]\n6",
      omittedLines: 3,
      omittedChars: 5,
    });
  });

  it("bounds a single long line by characters", () => {
    const result = boundText("x".repeat(50), BOUNDS);
    expect(result.text).toBe(`${"x".repeat(20)}\n[… 1 line omitted …]\n${"x".repeat(10)}`);
    expect(result.omittedChars).toBe(20);
  });

  it("bounds long lines that survive the line bound", () => {
    const result = boundText(`${"a".repeat(30)}\nb\nc\nd\n${"z".repeat(30)}`, BOUNDS);
    expect(result.text.startsWith("a".repeat(20))).toBe(true);
    expect(result.text.endsWith("z".repeat(10))).toBe(true);
    expect(result.omittedChars).toBe(3 + 12 + 20);
  });

  it("keeps the first items and reports the rest", () => {
    expect(boundItems([1, 2, 3], 2)).toEqual({ items: [1, 2], omitted: 1 });
    expect(boundItems([1], 2)).toEqual({ items: [1], omitted: 0 });
  });
});
