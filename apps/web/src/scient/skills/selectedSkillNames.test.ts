import { describe, expect, it } from "vite-plus/test";

import { collectSelectedScientSkillNames } from "./selectedSkillNames";

describe("selected Scient skill names", () => {
  it("does not promote context labels to Skill selections", () => {
    const text =
      "$requested Inspect ![figure $pdf-authoring @data.csv plot](t3-context://v1/image/ctx_image) and [Terminal $latex-authoring output](t3-context://v1/terminal/ctx_terminal) $last";
    expect(collectSelectedScientSkillNames(text)).toEqual(["requested", "last"]);
  });

  it("collects exact names once, including a final token, without treating money as a Skill", () => {
    expect(
      collectSelectedScientSkillNames("Use $pdf and $pdf; spend $20 then $pdf $2spec"),
    ).toEqual(["pdf", "2spec"]);
  });

  it("leaves names outside Scient's name limit as ordinary text", () => {
    expect(collectSelectedScientSkillNames(`$${"x".repeat(65)} $pdf`)).toEqual(["pdf"]);
  });

  it("leaves a token inside a formula in an unused footnote as formula source", () => {
    expect(
      collectSelectedScientSkillNames("Explain this example.\n\n[^a]: $$\\text{a $deploy b}$$"),
    ).toEqual([]);
    // A no-break space is part of a label, as Words reads it.
    expect(
      collectSelectedScientSkillNames("Explain.\n\n[^a\u00a0b]: $$\\text{a $deploy b}$$"),
    ).toEqual([]);
  });

  it("leaves a token inside a formula chat reads as formula source", () => {
    expect(collectSelectedScientSkillNames("Solve \\(\\text{$pdf} + x\\) with $latex")).toEqual([
      "latex",
    ]);
  });
});
