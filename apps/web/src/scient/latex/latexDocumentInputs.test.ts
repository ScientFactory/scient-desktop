import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LatexDocumentInputs, type LatexInputState } from "./latexDocumentInputs";

const environmentId = EnvironmentId.make("environment-latex-inputs");
const at = (relativePath: string) => ({ environmentId, cwd: "/work/thesis", relativePath });

function inputsWith(calls: string[]) {
  const inputs = new LatexDocumentInputs();
  const owner = (relativePath: string, state: LatexInputState, root = relativePath) =>
    inputs.register({
      target: at(relativePath),
      root,
      finish: () => state === "clean",
      pending: () => state !== "clean",
      inspect: () => {
        calls.push(`inspect ${relativePath}`);
        return state;
      },
      commit: () => {
        calls.push(`commit ${relativePath}`);
        return state;
      },
    });
  owner("paper/main.tex", "clean");
  owner("paper/table.tex", "unconverted");
  owner("paper/typing.tex", "composing");
  // A chapter outside the folder whose document's root is inside it.
  owner("shared/chapter.tex", "unconverted", "paper/main.tex");
  owner("notes/other.tex", "unconverted");
  return inputs;
}

const inPaper = (target: { readonly relativePath: string }) =>
  target.relativePath.startsWith("paper/");

describe("LatexDocumentInputs.commitWhere", () => {
  it("commits only editors of files inside, and only inspects a chapter outside", () => {
    const calls: string[] = [];
    const unfinished = inputsWith(calls).commitWhere(inPaper);

    expect(calls).toEqual([
      "commit paper/main.tex",
      "commit paper/table.tex",
      "commit paper/typing.tex",
      "inspect shared/chapter.tex",
    ]);
    expect(unfinished).toEqual([
      { target: at("paper/table.tex"), state: "unconverted" },
      { target: at("paper/typing.tex"), state: "composing" },
      // Named by its root, the file in the folder.
      { target: at("paper/main.tex"), state: "unconverted" },
    ]);
  });

  it("reports the same without committing anything when only inspecting", () => {
    const calls: string[] = [];
    const inputs = inputsWith(calls);
    expect(inputs.inspectWhere(inPaper)).toEqual([
      { target: at("paper/table.tex"), state: "unconverted" },
      { target: at("paper/typing.tex"), state: "composing" },
      { target: at("paper/main.tex"), state: "unconverted" },
    ]);
    expect(calls.every((call) => call.startsWith("inspect"))).toBe(true);
  });
});
