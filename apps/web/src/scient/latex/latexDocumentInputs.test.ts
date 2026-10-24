import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LatexDocumentInputs } from "./latexDocumentInputs";

const environmentId = EnvironmentId.make("environment-latex-inputs");
const at = (relativePath: string) => ({ environmentId, cwd: "/work/thesis", relativePath });

describe("LatexDocumentInputs.finishWhere", () => {
  it("finishes only the picked editors and names those that could not finish", () => {
    const inputs = new LatexDocumentInputs();
    const finished: string[] = [];
    const owner = (relativePath: string, result: boolean, pending: boolean, root = relativePath) =>
      inputs.register({
        target: at(relativePath),
        root,
        finish: () => {
          finished.push(relativePath);
          return result;
        },
        pending: () => pending,
      });
    owner("paper/main.tex", true, false);
    owner("paper/table.tex", false, true);
    owner("paper/typing.tex", false, false);
    // A chapter outside the folder whose document's root is inside it.
    owner("shared/chapter.tex", false, true, "paper/main.tex");
    owner("notes/other.tex", false, true);

    const unfinished = inputs.finishWhere((target) => target.relativePath.startsWith("paper/"));

    expect(finished).toEqual([
      "paper/main.tex",
      "paper/table.tex",
      "paper/typing.tex",
      "shared/chapter.tex",
    ]);
    expect(unfinished).toEqual([
      { target: at("paper/table.tex"), pending: true },
      { target: at("paper/typing.tex"), pending: false },
      // Named by its root, the file in the folder.
      { target: at("paper/main.tex"), pending: true },
    ]);
  });
});
