import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ControlledLatexPresentRequest,
  ScientLatexPdfBuildInput,
  ScientLatexPdfBuildResult,
} from "./latexPdfBuild.ts";

const decodeInput = Schema.decodeUnknownSync(ScientLatexPdfBuildInput);
const decodeResult = Schema.decodeUnknownSync(ScientLatexPdfBuildResult);
const decodePresentation = Schema.decodeUnknownSync(ControlledLatexPresentRequest);

describe("Scient LaTeX PDF build contract", () => {
  it("keeps the public request to one project source and one project output", () => {
    expect(decodeInput({ sourcePath: "paper/main.tex", outputPath: "outputs/paper.pdf" })).toEqual({
      sourcePath: "paper/main.tex",
      outputPath: "outputs/paper.pdf",
    });
    expect(() => decodeInput({ sourcePath: "", outputPath: "paper.pdf" })).toThrow();
    expect(() =>
      decodeInput({ sourcePath: "paper.tex\0ignored", outputPath: "paper.pdf" }),
    ).toThrow();
  });

  it("hands the desktop only the resolved project-relative LaTeX root", () => {
    expect(decodePresentation({ rootSourcePath: "paper/main.tex" })).toEqual({
      rootSourcePath: "paper/main.tex",
    });
    expect(() => decodePresentation({ rootSourcePath: "" })).toThrow();
    expect(() => decodePresentation({ rootSourcePath: "paper.tex\0ignored" })).toThrow();
  });

  it("exposes a paced in-progress result instead of holding an agent turn indefinitely", () => {
    expect(
      decodeResult({
        status: "in-progress",
        sourcePath: "chapters/results.tex",
        rootSourcePath: "main.tex",
        outputPath: "main.pdf",
        buildState: "running",
        toolchain: {
          kind: "latexmk",
          executable: "/managed/latexmk",
          version: "4.86",
          probedAtEpochMs: 1,
          source: "scient-managed",
        },
        installingPackages: ["amsmath"],
        retryAfterMs: 1_500,
      }),
    ).toMatchObject({
      status: "in-progress",
      rootSourcePath: "main.tex",
      retryAfterMs: 1_500,
    });
    expect(() =>
      decodeResult({
        status: "in-progress",
        sourcePath: "main.tex",
        rootSourcePath: "main.tex",
        outputPath: "main.pdf",
        buildState: "running",
        toolchain: null,
        installingPackages: [],
        retryAfterMs: 249,
      }),
    ).toThrow();
  });
});
