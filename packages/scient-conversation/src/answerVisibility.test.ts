import { describe, expect, it } from "vite-plus/test";

import { isSubstantiveAnswer, SUBSTANTIVE_ANSWER_MIN_CHARS } from "./answerVisibility.ts";

describe("isSubstantiveAnswer", () => {
  it("folds short progress notes, including several short sentences", () => {
    expect(isSubstantiveAnswer("Pushed. Next is a short final Codex re-review.")).toBe(false);
    expect(isSubstantiveAnswer("Let me check the tests…")).toBe(false);
    expect(
      isSubstantiveAnswer("Tests pass. The build is still running. I'm checking the lint next."),
    ).toBe(false);
    expect(isSubstantiveAnswer("")).toBe(false);
  });

  it("keeps a message of at least the minimum length", () => {
    expect(isSubstantiveAnswer("a".repeat(SUBSTANTIVE_ANSWER_MIN_CHARS))).toBe(true);
    expect(isSubstantiveAnswer("a".repeat(SUBSTANTIVE_ANSWER_MIN_CHARS - 1))).toBe(false);
    // Surrounding whitespace does not count.
    expect(isSubstantiveAnswer(`  ${"a".repeat(SUBSTANTIVE_ANSWER_MIN_CHARS - 1)}\n\n`)).toBe(
      false,
    );
  });

  it("keeps headings", () => {
    expect(isSubstantiveAnswer("## Diagnosis\nThe cache is stale.")).toBe(true);
    expect(isSubstantiveAnswer("Diagnosis\n=========\nThe cache is stale.")).toBe(true);
    expect(isSubstantiveAnswer("Diagnosis\n---------\nThe cache is stale.")).toBe(true);
    // A hash tag or an empty heading is not a heading.
    expect(isSubstantiveAnswer("#478 is merged.")).toBe(false);
    expect(isSubstantiveAnswer("#\nDone.")).toBe(false);
  });

  it("keeps a list of two or more items, not a single item", () => {
    expect(isSubstantiveAnswer("Found two issues:\n- the cache\n- the retry")).toBe(true);
    expect(isSubstantiveAnswer("Steps:\n1. Build\n2. Test")).toBe(true);
    expect(isSubstantiveAnswer("Checklist\n1. Confirm the deploy.")).toBe(false);
    // Items or a heading made of inline code still count.
    expect(isSubstantiveAnswer("- `foo`\n- `bar`")).toBe(true);
    expect(isSubstantiveAnswer("## `parse()`")).toBe(true);
  });

  it("keeps tables, fenced code, display math and images", () => {
    expect(isSubstantiveAnswer("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(isSubstantiveAnswer("Run:\n```sh\npnpm test\n```")).toBe(true);
    expect(isSubstantiveAnswer("~~~mermaid\ngraph TD; A-->B\n~~~")).toBe(true);
    expect(isSubstantiveAnswer("The energy is\n$$E = mc^2$$")).toBe(true);
    expect(isSubstantiveAnswer("\\[\nx^2\n\\]")).toBe(true);
    expect(isSubstantiveAnswer("Consider \\[E = mc^2\\] within a sentence.")).toBe(true);
    expect(isSubstantiveAnswer("\\begin{align*}\nx &= 1\n\\end{align*}")).toBe(true);
    expect(isSubstantiveAnswer("Here: ![plot](plot.png)")).toBe(true);
    expect(isSubstantiveAnswer("![plot][chart]\n\n[chart]: ./plot.png")).toBe(true);
    expect(isSubstantiveAnswer("![chart]\n\n[chart]: ./plot.png")).toBe(true);
    // Labels match as CommonMark normalises them; a destination may sit on the next line.
    expect(isSubstantiveAnswer("![build  chart]\n\n[Build chart]: ./plot.png")).toBe(true);
    expect(isSubstantiveAnswer("![chart]\n\n[chart]:\n  ./plot.png")).toBe(true);
    expect(isSubstantiveAnswer("![chart][]\n\n[chart]: ./plot.png")).toBe(true);
    expect(isSubstantiveAnswer("Done.", { hasImages: true })).toBe(true);
  });

  it("does not mistake prose for structure", () => {
    expect(isSubstantiveAnswer("It costs $5 and $6.")).toBe(false);
    expect(isSubstantiveAnswer("a | b, and --- then more")).toBe(false);
    // A list item's underline is a rule, not a heading.
    expect(isSubstantiveAnswer("- one item\n---")).toBe(false);
    // Syntax inside inline code is shown literally.
    expect(isSubstantiveAnswer("Checking the `$$` parser next.")).toBe(false);
    expect(isSubstantiveAnswer("Checking the `<img>` handler next.")).toBe(false);
    expect(isSubstantiveAnswer("Checking `![a](b)` and `\\[x\\]` next.")).toBe(false);
    // An unclosed opener is not display math; a bare shortcut reference is not an image.
    expect(isSubstantiveAnswer("The $$ sign and \\[ bracket.")).toBe(false);
    expect(isSubstantiveAnswer("See ![note] later.")).toBe(false);
    // A reference image needs its definition; math stays within a paragraph.
    expect(isSubstantiveAnswer("Checking ![plot][chart] resolution next.")).toBe(false);
    expect(isSubstantiveAnswer("Checking $$ handling.\n\nThe $$ parser is next.")).toBe(false);
    // A quote's underline is a rule, not a heading.
    expect(isSubstantiveAnswer("> Still checking the tests.\n---")).toBe(false);
    // Inline code may cross a line break, and use longer backtick runs.
    expect(isSubstantiveAnswer("Checking `![a](b)\nparser` next.")).toBe(false);
    expect(isSubstantiveAnswer("Checking ``a ` $$x$$`` next.")).toBe(false);
    expect(isSubstantiveAnswer("See [the docs](https://example.com).")).toBe(false);
  });
});
