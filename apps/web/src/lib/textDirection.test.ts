import { describe, expect, it } from "vitest";

import {
  resolveRawTextDirectionHint,
  resolveTextDirection,
  stripTechnicalTextFragments,
} from "./textDirection";

describe("resolveTextDirection", () => {
  it("uses dominant natural-language words instead of the first strong character", () => {
    expect(resolveTextDirection("Scient הוא כלי למחקר מדעי")).toBe("rtl");
    expect(resolveTextDirection("English prose with a single מונח in the middle")).toBe("ltr");
  });

  it("does not let a long medical term outweigh several short Hebrew words", () => {
    expect(resolveTextDirection("Pseudopseudohypoparathyroidism הוא מונח רפואי נדיר")).toBe("rtl");
    expect(resolveTextDirection("MRI ו-CT הן בדיקות חשובות")).toBe("rtl");
  });

  it("recognizes contemporary RTL scripts beyond Hebrew and Arabic", () => {
    expect(resolveTextDirection("\u{10e80}\u{10e81}")).toBe("rtl");
    expect(resolveTextDirection("\u{1e800}\u{1e801}")).toBe("rtl");
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

  it("uses the same dominance threshold before and after streaming completes", () => {
    const text = "one two three four אחד שני שלושה";
    expect(resolveTextDirection(text, { hint: "rtl", provisional: true })).toBe("rtl");
    expect(resolveTextDirection(text, { hint: "rtl" })).toBe("rtl");
    expect(resolveTextDirection("Done", { hint: "rtl", provisional: true })).toBe("rtl");
    expect(resolveTextDirection("Done", { hint: "rtl" })).toBe("rtl");
  });
});

describe("resolveRawTextDirectionHint", () => {
  it("ignores code, URLs, paths, mentions, and skill tokens in raw user text", () => {
    expect(resolveRawTextDirectionHint("`evidence-to-note` הופך ראיה להערה")).toBe("rtl");
    expect(resolveRawTextDirectionHint("@src/App.tsx שלום, בדוק את הקובץ")).toBe("rtl");
    expect(resolveRawTextDirectionHint("src/App.tsx, שלום")).toBe("rtl");
    expect(resolveRawTextDirectionHint("/Users/yaacov/project/src/App.tsx שלום, בדוק")).toBe("rtl");
    expect(resolveRawTextDirectionHint("~/project/src/App.tsx שלום, בדוק")).toBe("rtl");
    expect(resolveRawTextDirectionHint("C:\\project\\src\\App.tsx שלום, בדוק")).toBe("rtl");
    expect(resolveRawTextDirectionHint("App.tsx, שלום")).toBe("rtl");
    expect(resolveRawTextDirectionHint("dev@example.com כתבו לכתובת הזאת")).toBe("rtl");
    expect(resolveRawTextDirectionHint("https://scientfactory.com תסביר לי את האתר")).toBe("rtl");
    expect(resolveRawTextDirectionHint("$scient-skill-authoring תעזור לי לכתוב מיומנות")).toBe(
      "rtl",
    );
  });

  it("does not mistake ordinary dotted abbreviations for filenames", () => {
    expect(stripTechnicalTextFragments("e.g. this remains English")).toContain("e.g.");
    expect(stripTechnicalTextFragments("U.S. guidance remains English")).toContain("U.S.");
    expect(stripTechnicalTextFragments("App.tsx, שלום")).not.toContain("App.tsx");
  });
});
