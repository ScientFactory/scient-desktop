import { describe, expect, it } from "vite-plus/test";

import { latexSourceChoices } from "./latexCommandCompletion";

describe("latexSourceChoices", () => {
  it("offers bounded command and environment completions", () => {
    expect(latexSourceChoices("\\[\n\\fra", 7, "source")[0]).toMatchObject({
      label: "\\frac",
      replacement: "\\frac{}{}",
    });
    expect(latexSourceChoices("\\[\n\\begin{ali", 13, "source")[0]).toMatchObject({
      label: "\\begin{align}",
      replacement: "\\begin{align}\n\n\\end{align}",
    });
  });
});
