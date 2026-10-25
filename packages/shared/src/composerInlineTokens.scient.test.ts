import { describe, expect, it } from "vite-plus/test";
import {
  collectComposerInlineTokens,
  collectSelectedScientSkillNames,
} from "./composerInlineTokens.ts";

describe("composer Scient selection metadata", () => {
  it("does not promote context labels to Skill selections or file mentions", () => {
    const text =
      "$requested Inspect ![figure $pdf-authoring @data.csv plot](t3-context://v1/image/ctx_image) and [Terminal $latex-authoring output](t3-context://v1/terminal/ctx_terminal) $last";
    expect(collectSelectedScientSkillNames(text)).toEqual(["requested", "last"]);
    expect(collectComposerInlineTokens(`${text}\n`).map((token) => token.source)).toEqual([
      "$requested",
      "$last",
    ]);
  });
  it("collects exact names once, including a final token, without treating money as a Skill", () => {
    expect(
      collectSelectedScientSkillNames("Use $pdf and $pdf; spend $20 then $pdf $2spec"),
    ).toEqual(["pdf", "2spec"]);
  });
  it("leaves names outside Scient's name limit as ordinary text", () => {
    expect(collectSelectedScientSkillNames(`$${"x".repeat(65)} $pdf`)).toEqual(["pdf"]);
  });
});
