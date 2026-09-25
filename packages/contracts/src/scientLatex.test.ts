import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ScientLatexResolveRequest, ScientLatexResolveResult } from "./scientLatex.ts";

const decodeRequest = Schema.decodeUnknownSync(ScientLatexResolveRequest);
const decodeResult = Schema.decodeUnknownSync(ScientLatexResolveResult);

describe("Scient LaTeX document-root resolution contract", () => {
  it("carries workspace-relative source and optional selected-root context", () => {
    expect(
      decodeRequest({
        workspaceRoot: "/workspace/project",
        sourceRelativePath: "chapters/results.tex",
        contextRootRelativePath: "paper/main.tex",
      }),
    ).toEqual({
      workspaceRoot: "/workspace/project",
      sourceRelativePath: "chapters/results.tex",
      contextRootRelativePath: "paper/main.tex",
    });
  });

  it("reports incomplete inference and candidate roots without guessing", () => {
    expect(
      decodeResult({
        _tag: "unresolved",
        sourceRelativePath: "chapters/results.tex",
        candidates: [
          {
            rootRelativePath: "paper/main.tex",
            evidence: ["static-dependency"],
            independentlyCompilable: true,
          },
        ],
        complete: false,
        incompleteReasons: ["dynamic-input"],
      }),
    ).toMatchObject({
      _tag: "unresolved",
      complete: false,
      incompleteReasons: ["dynamic-input"],
      candidates: [{ rootRelativePath: "paper/main.tex" }],
    });
  });
});
