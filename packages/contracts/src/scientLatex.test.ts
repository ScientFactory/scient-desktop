import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ScientLatexResolveRequest,
  ScientLatexResolveResult,
  ScientLatexToolchainReport,
} from "./scientLatex.ts";

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

describe("Scient LaTeX toolchain download facts", () => {
  const decodeReport = Schema.decodeUnknownSync(ScientLatexToolchainReport);
  const report = {
    kind: null,
    executable: null,
    version: null,
    probedAtEpochMs: 1,
    compilers: [],
    canInstallManaged: true,
  };

  it("accepts old servers without inventing a download size", () => {
    expect(decodeReport(report).downloadBytes).toBeUndefined();
  });

  it("distinguishes a pinned size from an unsupported host's null size", () => {
    expect(decodeReport({ ...report, downloadBytes: 67_051_368 }).downloadBytes).toBe(67_051_368);
    expect(
      decodeReport({ ...report, canInstallManaged: false, downloadBytes: null }).downloadBytes,
    ).toBeNull();
  });
});
