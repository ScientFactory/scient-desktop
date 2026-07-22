import { describe, expect, it } from "vitest";

import { resolveRawTextDirectionHint, resolveTextDirection } from "./textDirection";

describe("resolveTextDirection", () => {
  it("uses dominant natural-language words instead of the first strong character", () => {
    expect(resolveTextDirection("Scient הוא כלי למחקר מדעי")).toBe("rtl");
    expect(resolveTextDirection("English prose with a single מונח in the middle")).toBe("ltr");
  });

  it("does not let a long medical term outweigh several short Hebrew words", () => {
    expect(resolveTextDirection("Pseudopseudohypoparathyroidism הוא מונח רפואי נדיר")).toBe("rtl");
    expect(resolveTextDirection("MRI ו-CT הן בדיקות חשובות")).toBe("rtl");
  });

  it("uses the hint for genuinely ambiguous or non-linguistic content", () => {
    expect(resolveTextDirection("שלום world", { hint: "rtl" })).toBe("rtl");
    expect(resolveTextDirection("123 --", { hint: "ltr" })).toBe("ltr");
    expect(resolveTextDirection("123 --")).toBe("auto");
  });

  it("lets clearly opposite completed content override a conversational hint", () => {
    expect(
      resolveTextDirection("This answer is intentionally written in English.", { hint: "rtl" }),
    ).toBe("ltr");
  });

  it("keeps a weak streaming hint through a short opposite-language opening", () => {
    expect(resolveTextDirection("Scient הוא", { hint: "rtl", provisional: true })).toBe("rtl");
    expect(
      resolveTextDirection("This answer is intentionally", { hint: "rtl", provisional: true }),
    ).toBe("ltr");
    expect(
      resolveTextDirection("This answer remains clearly English despite one מונח", {
        hint: "rtl",
        provisional: true,
      }),
    ).toBe("ltr");
  });
});

describe("resolveRawTextDirectionHint", () => {
  it("ignores code, URLs, paths, mentions, and skill tokens in raw user text", () => {
    expect(resolveRawTextDirectionHint("`evidence-to-note` הופך ראיה להערה")).toBe("rtl");
    expect(resolveRawTextDirectionHint("@src/App.tsx שלום, בדוק את הקובץ")).toBe("rtl");
    expect(resolveRawTextDirectionHint("/Users/yaacov/project/src/App.tsx שלום, בדוק")).toBe("rtl");
    expect(resolveRawTextDirectionHint("~/project/src/App.tsx שלום, בדוק")).toBe("rtl");
    expect(resolveRawTextDirectionHint("C:\\project\\src\\App.tsx שלום, בדוק")).toBe("rtl");
    expect(resolveRawTextDirectionHint("https://scientfactory.com תסביר לי את האתר")).toBe("rtl");
    expect(resolveRawTextDirectionHint("$scient-skill-authoring תעזור לי לכתוב מיומנות")).toBe(
      "rtl",
    );
  });
});
