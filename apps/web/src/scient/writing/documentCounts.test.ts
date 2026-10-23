import { describe, expect, it } from "vite-plus/test";

import { countWords, formatWordCount } from "./documentCounts";

describe("document word counts", () => {
  it("counts words separated by any white space, in any script", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("  one   two\nthree\tfour ")).toBe(4);
    expect(countWords("שלום עולם and English")).toBe(4);
    expect(countWords("x = y + 1")).toBe(5);
  });

  it("words the count for the footer", () => {
    expect(formatWordCount({ total: 0, selected: null })).toBe("0 words");
    expect(formatWordCount({ total: 1, selected: null })).toBe("1 word");
    expect(formatWordCount({ total: 1284, selected: null })).toBe("1,284 words");
    expect(formatWordCount({ total: 1284, selected: 12 })).toBe("12 of 1,284 words");
    expect(formatWordCount({ total: 1284, selected: 0 })).toBe("1,284 words");
  });
});
