import { describe, expect, it } from "vite-plus/test";

import {
  applyDocumentSourcePatches,
  DocumentSourcePatchError,
  type DocumentSourcePatch,
  type DocumentSourcePatchProblem,
} from "./sourcePatch.ts";

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function problemOf(source: string, patches: readonly DocumentSourcePatch[]) {
  try {
    applyDocumentSourcePatches(source, patches);
    return null;
  } catch (error) {
    if (error instanceof DocumentSourcePatchError) return error.problem;
    throw error;
  }
}

describe("applyDocumentSourcePatches", () => {
  it("applies several patches without touching the source around them", () => {
    const source = "α 😀 beta\r\nsecond line\r\n";
    const betaStart = source.indexOf("beta");
    const secondStart = source.indexOf("second");
    expect(
      applyDocumentSourcePatches(source, [
        { start: secondStart, end: secondStart + "second".length, replacement: "שנייה" },
        { start: betaStart, end: betaStart + "beta".length, replacement: "gamma" },
      ]),
    ).toBe("α 😀 gamma\r\nשנייה line\r\n");
  });

  it.each<[string, string, readonly DocumentSourcePatch[], DocumentSourcePatchProblem]>([
    [
      "overlapping patches",
      "abcdef",
      [
        { start: 1, end: 4, replacement: "x" },
        { start: 3, end: 5, replacement: "y" },
      ],
      "overlap",
    ],
    [
      "an insertion inside a replaced range",
      "abcdef",
      [
        { start: 1, end: 4, replacement: "x" },
        { start: 2, end: 2, replacement: "y" },
      ],
      "overlap",
    ],
    [
      "two replacements that start together",
      "abcdef",
      [
        { start: 1, end: 3, replacement: "x" },
        { start: 1, end: 4, replacement: "y" },
      ],
      "overlap",
    ],
    [
      "a boundary inside a surrogate pair",
      "😀",
      [{ start: 1, end: 1, replacement: "x" }],
      "surrogate",
    ],
    ["a boundary inside CRLF", "a\r\nb", [{ start: 2, end: 2, replacement: "x" }], "crlf"],
    ["a start before the source", "abc", [{ start: -1, end: 2, replacement: "x" }], "bounds"],
    ["an end after the source", "abc", [{ start: 1, end: 4, replacement: "x" }], "bounds"],
    ["an end before its start", "abc", [{ start: 2, end: 1, replacement: "x" }], "bounds"],
    ["a fractional offset", "abc", [{ start: 0.5, end: 2, replacement: "x" }], "offset"],
  ])("refuses %s", (_name, source, patches, problem) => {
    expect(problemOf(source, patches)).toBe(problem);
  });

  it("refuses the whole set when one patch is unsafe, leaving nothing half applied", () => {
    const source = "one two three";
    expect(() =>
      applyDocumentSourcePatches(source, [
        { start: 0, end: 3, replacement: "ONE" },
        { start: 8, end: 99, replacement: "x" },
      ]),
    ).toThrow("outside");
  });

  it("applies a patch only where the source still holds the text it was planned on", () => {
    const planned = [{ start: 4, end: 7, replacement: "2", expected: "two" }];
    expect(applyDocumentSourcePatches("one two three", planned)).toBe("one 2 three");
    // The same offsets over a source that moved underneath the plan.
    expect(problemOf("one TWO three", planned)).toBe("stale");
    expect(problemOf("a one two three", planned)).toBe("stale");
    // An insertion states that nothing is replaced.
    expect(
      applyDocumentSourcePatches("ab", [{ start: 1, end: 1, replacement: "-", expected: "" }]),
    ).toBe("a-b");
  });

  it("places patches that start at one offset in the order given, insertions first", () => {
    expect(
      applyDocumentSourcePatches("ab", [
        { start: 1, end: 1, replacement: "1" },
        { start: 1, end: 1, replacement: "2" },
      ]),
    ).toBe("a12b");
    expect(
      applyDocumentSourcePatches("ab", [
        { start: 1, end: 1, replacement: "2" },
        { start: 1, end: 1, replacement: "1" },
      ]),
    ).toBe("a21b");
    // An insertion at the start of a replaced range lands before the replacement,
    // and one at its end lands after it, whatever order they are given in.
    expect(
      applyDocumentSourcePatches("abcd", [
        { start: 1, end: 3, replacement: "X" },
        { start: 3, end: 3, replacement: ">" },
        { start: 1, end: 1, replacement: "<" },
      ]),
    ).toBe("a<X>d");
  });

  it("matches a token oracle for 2,000 unordered Unicode patch sets", () => {
    const tokenPool = ["a", "ב", "ع", "😀", "é", "\r\n", "\n", "_", "[]"] as const;
    const words = ["x", "ß", "数", "né", "", "  "] as const;
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const random = deterministicRandom(seed * 17);
      const tokens = Array.from(
        { length: 2 + Math.floor(random() * 20) },
        () => tokenPool[Math.floor(random() * tokenPool.length)] ?? "x",
      );
      const patches: DocumentSourcePatch[] = [];
      const expected: string[] = [];
      let offset = 0;
      tokens.forEach((token, index) => {
        if (random() < 0.28) {
          const word = words[Math.floor(random() * words.length)] ?? "x";
          const replacement = `${word}${index % 3 === 0 ? "😀" : ""}`;
          patches.push({ start: offset, end: offset + token.length, replacement, expected: token });
          expected.push(replacement);
        } else {
          expected.push(token);
        }
        offset += token.length;
      });
      const source = tokens.join("");
      expect(applyDocumentSourcePatches(source, patches.toReversed())).toBe(expected.join(""));
    }
  });
});
