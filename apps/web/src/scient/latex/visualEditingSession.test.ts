import { editVisualRun, matchVisualRun } from "@t3tools/shared/latexVisual";
import { describe, expect, it } from "vite-plus/test";
import { rebaseVisualMatch, sourceChange } from "./visualEditingSession";

const source = `\\documentclass{article}
\\begin{document}
First paragraph.

Second editable paragraph.
\\end{document}
`;

describe("Visual editing session", () => {
  it("keeps a compiled-page match addressable through sequential minimal source edits", () => {
    const compiledMatch = matchVisualRun(source, "Second editable paragraph.", 20, 5)!;
    const first = source.replace("First", "A much longer first");
    const firstChange = sourceChange(source, first);
    const firstRebased = rebaseVisualMatch(compiledMatch, first, [firstChange])!;
    expect(firstRebased.run.text).toBe("Second editable paragraph.");

    const second = editVisualRun(
      first,
      firstRebased.run,
      firstRebased.run.text.replace("editable", "visually editable"),
    );
    const secondChange = sourceChange(first, second);
    const rebased = rebaseVisualMatch(compiledMatch, second, [firstChange, secondChange])!;

    expect(rebased.run.text).toBe("Second visually editable paragraph.");
    expect(rebased.offset).toBe(compiledMatch.offset + "visually ".length);
  });

  it("fails closed when an edit removes the matched prose island", () => {
    const compiledMatch = matchVisualRun(source, "Second editable paragraph.", 8, 5)!;
    const current = source.replace("Second editable paragraph.", "$x$");
    expect(rebaseVisualMatch(compiledMatch, current, [sourceChange(source, current)])).toBeNull();
  });
});
