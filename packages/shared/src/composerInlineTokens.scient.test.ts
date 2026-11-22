import { describe, expect, it } from "vite-plus/test";
import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

describe("composer Scient selection metadata", () => {
  it("does not promote context labels to Skill selections or file mentions", () => {
    const text =
      "$requested Inspect ![figure $pdf-authoring @data.csv plot](t3-context://v1/image/ctx_image) and [Terminal $latex-authoring output](t3-context://v1/terminal/ctx_terminal) $last";
    expect(collectComposerInlineTokens(`${text}\n`).map((token) => token.source)).toEqual([
      "$requested",
      "$last",
    ]);
  });
});
