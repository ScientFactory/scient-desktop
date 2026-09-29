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

  it("leaves text it already bounded as it is", () => {
    const boundsList = [
      BOUNDS,
      { headLines: 30, tailLines: 15, headChars: 6_000, tailChars: 2_000 },
      { headLines: 12, tailLines: 4, headChars: 2_000, tailChars: 500 },
      { headLines: 20, tailLines: 5, headChars: 2_000, tailChars: 500 },
    ];
    // A small deterministic generator: many lines, long lines, blank lines,
    // CRLF, and lines that look like omission lines.
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const line = () => {
      switch (random(6)) {
        case 0:
          return "";
        case 1:
          return "x".repeat(random(12_000));
        case 2:
          return `[… ${random(50)} lines omitted …]`;
        default:
          return `line ${random(1_000)}`.repeat(1 + random(4));
      }
    };
    const inputs = [
      // The reviewer's case: 46 lines, one of them far longer than the character bounds.
      [
        ...Array.from({ length: 23 }, (_, index) => `head ${index}`),
        "y".repeat(10_000),
        ...Array.from({ length: 22 }, (_, index) => `tail ${index}`),
      ].join("\n"),
      ...Array.from({ length: 300 }, () =>
        Array.from({ length: 1 + random(120) }, line).join(random(4) === 0 ? "\r\n" : "\n"),
      ),
    ];
    // Text shaped like bounded output that is not: every one must be cut.
    const adversarial = (bounds: (typeof boundsList)[number]) => {
      const head = "h".repeat(bounds.headChars);
      const tail = "t".repeat(bounds.tailChars);
      return [
        // The reviewer's case: one huge "omission line".
        `[… ${"9".repeat(100_000)} lines omitted …]`,
        `${head}\n[… 1234567890 lines omitted …]\n${tail}`,
        `${head}\n[… 007 lines omitted …]\n${tail}`,
        `${head}\n[… 0 lines omitted …]\n${tail}`,
        `${head}\n[… 1 lines omitted …]\n${tail}`,
        `${head}\n[… 2 line omitted …]\n${tail}`,
        `${head}h\n[… 3 lines omitted …]\n${tail}`,
        `${head}\n[… 3 lines omitted …]\n${tail}t`,
      ];
    };
    const maxMarker = "[… 999999999 lines omitted …]".length;
    for (const bounds of boundsList) {
      const cut = adversarial(bounds);
      for (const input of [...inputs, ...cut]) {
        const once = boundText(input, bounds);
        if (cut.includes(input)) expect(once.omittedChars).toBeGreaterThan(0);
        expect(once.text.length).toBeLessThanOrEqual(
          bounds.headChars + bounds.tailChars + 2 + maxMarker,
        );
        expect(once.text.split("\n").length).toBeLessThanOrEqual(
          bounds.headLines + bounds.tailLines + 3,
        );
        expect(boundText(once.text, bounds)).toEqual({
          text: once.text,
          omittedLines: 0,
          omittedChars: 0,
        });
      }
    }
  });

  it("still bounds long text that merely contains an omission line", () => {
    const text = Array.from({ length: 100 }, (_, index) =>
      index === 50 ? "[… 3 lines omitted …]" : `line ${index}`,
    ).join("\n");
    expect(boundText(text, BOUNDS).omittedLines).toBe(97);
  });

  it("keeps the first items and reports the rest", () => {
    expect(boundItems([1, 2, 3], 2)).toEqual({ items: [1, 2], omitted: 1 });
    expect(boundItems([1], 2)).toEqual({ items: [1], omitted: 0 });
  });
});
