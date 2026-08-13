import { describe, expect, it } from "vite-plus/test";

import { normalizeScientMathDelimiters } from "./scientMathText";

describe("normalizeScientMathDelimiters", () => {
  it("rewrites inline delimiters and trims the expression", () => {
    expect(normalizeScientMathDelimiters("The value \\( x^2 \\) grows.")).toBe(
      "The value $x^2$ grows.",
    );
  });

  it("keeps inline content verbatim apart from the outer whitespace", () => {
    expect(normalizeScientMathDelimiters("\\(\\alpha_{i} + \\beta^{2}\\)")).toBe(
      "$\\alpha_{i} + \\beta^{2}$",
    );
  });

  it("opens a display block when the expression stands on its own line", () => {
    expect(normalizeScientMathDelimiters("Energy:\n\\[ E = mc^2 \\]\nas shown.")).toBe(
      "Energy:\n$$\nE = mc^2\n$$\nas shown.",
    );
  });

  it("preserves the line structure of multiline display math", () => {
    const text = "\\[\na = b \\\\\nc = d\n\\]";

    expect(normalizeScientMathDelimiters(text)).toBe("$$\na = b \\\\\nc = d\n$$");
  });

  it("keeps a display block inside the list item it was indented into", () => {
    expect(normalizeScientMathDelimiters("- step:\n  \\[x\\]\n")).toBe(
      "- step:\n  $$\n  x\n  $$\n",
    );
    expect(normalizeScientMathDelimiters("- step:\n  \\[\n  a = b\n  \\]\n")).toBe(
      "- step:\n  $$\n  a = b\n  $$\n",
    );
  });

  it("keeps display math embedded in a sentence on one line", () => {
    expect(normalizeScientMathDelimiters("Given \\[ x \\] we continue.")).toBe(
      "Given $$x$$ we continue.",
    );
  });

  it("leaves fenced code blocks untouched", () => {
    const text = "```tex\n\\( x \\)\n\\[ y \\]\n```\nthen \\( z \\)";

    expect(normalizeScientMathDelimiters(text)).toBe("```tex\n\\( x \\)\n\\[ y \\]\n```\nthen $z$");
  });

  it("leaves an unterminated fence untouched to the end of the text", () => {
    const text = "```\n\\( x \\)";

    expect(normalizeScientMathDelimiters(text)).toBe(text);
  });

  it("leaves inline code spans untouched", () => {
    expect(normalizeScientMathDelimiters("Write `\\(x\\)` to get \\(x\\).")).toBe(
      "Write `\\(x\\)` to get $x$.",
    );
  });

  it("leaves an escaped opener alone", () => {
    expect(normalizeScientMathDelimiters("A literal \\\\(x\\\\) stays.")).toBe(
      "A literal \\\\(x\\\\) stays.",
    );
  });

  it("leaves unmatched openers alone", () => {
    expect(normalizeScientMathDelimiters("\\( never closed")).toBe("\\( never closed");
    expect(normalizeScientMathDelimiters("\\[ never closed")).toBe("\\[ never closed");
  });

  it("pairs delimiters non-greedily across several expressions", () => {
    expect(normalizeScientMathDelimiters("\\(a\\) and \\(b\\)")).toBe("$a$ and $b$");
  });

  it("rewrites mixed inline and display math in one message", () => {
    const text = [
      "Given \\( a \\ne 0 \\), the roots are:",
      "\\[",
      "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "\\]",
      "```js",
      "const s = \\(x\\);",
      "```",
      "and `\\(y\\)` stays code.",
    ].join("\n");

    expect(normalizeScientMathDelimiters(text)).toBe(
      [
        "Given $a \\ne 0$, the roots are:",
        "$$",
        "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
        "$$",
        "```js",
        "const s = \\(x\\);",
        "```",
        "and `\\(y\\)` stays code.",
      ].join("\n"),
    );
  });

  it("returns text without TeX delimiters unchanged", () => {
    const text = "Plain prose with $5 and a \\ backslash.";

    expect(normalizeScientMathDelimiters(text)).toBe(text);
  });
});
