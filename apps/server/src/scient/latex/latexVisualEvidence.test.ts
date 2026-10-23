import { describe, expect, it } from "@effect/vitest";
import {
  latexBuildInputsChangedDuringCompile,
  latexVisualNeedsRequalification,
  latexVisualSourceRevisions,
  type LatexBuildEvidence,
} from "./latexBuildEvidence.ts";

const evidence = (digest = "a".repeat(64)): LatexBuildEvidence => ({
  schemaVersion: 1,
  rootRelativePath: "main.tex",
  recordedAtEpochMs: 1,
  truncated: false,
  dependencies: [{ path: "main.tex", sha256: digest, byteLength: 42 }],
});

describe("visual compile evidence", () => {
  it("uses the same content-revision convention as workspace CAS writes", () => {
    expect(latexVisualSourceRevisions(evidence(), evidence())).toEqual({
      "main.tex": `sha256:${"a".repeat(64)}`,
    });
  });
  it("fails closed when input changed during compilation", () => {
    expect(latexVisualSourceRevisions(evidence(), evidence("b".repeat(64)))).toEqual({});
  });
  it("fails closed for unknown, missing, truncated or newly discovered inputs", () => {
    for (const digest of ["unverified", "missing", "oversize", ""])
      expect(latexVisualSourceRevisions(evidence(digest), evidence(digest))).toEqual({});
    expect(latexVisualSourceRevisions({ ...evidence(), truncated: true }, evidence())).toEqual({});
    expect(latexVisualSourceRevisions(evidence(), { ...evidence(), truncated: true })).toEqual({});
    expect(
      latexVisualSourceRevisions(evidence(), {
        ...evidence(),
        dependencies: [
          ...evidence().dependencies,
          { path: "chapter.tex", sha256: "c".repeat(64), byteLength: 12 },
        ],
      }),
    ).toEqual({});
  });
  it("requests only one bounded stabilization opportunity for newly known complete inputs", () => {
    const discovered = {
      ...evidence(),
      dependencies: [
        ...evidence().dependencies,
        { path: "chapter.tex", sha256: "c".repeat(64), byteLength: 12 },
      ],
    };
    expect(latexVisualNeedsRequalification(evidence(), discovered)).toBe(true);
    expect(latexVisualNeedsRequalification(discovered, discovered)).toBe(false);
    expect(latexVisualNeedsRequalification(evidence(), evidence("b".repeat(64)))).toBe(true);
    expect(latexVisualNeedsRequalification(evidence(), { ...discovered, truncated: true })).toBe(
      false,
    );
    expect(latexVisualNeedsRequalification({ ...evidence(), truncated: true }, discovered)).toBe(
      true,
    );
  });
  it("detects a definite in-compile source change without guessing from incomplete evidence", () => {
    expect(latexBuildInputsChangedDuringCompile(evidence(), evidence())).toBe(false);
    expect(latexBuildInputsChangedDuringCompile(evidence(), evidence("b".repeat(64)))).toBe(true);
    expect(
      latexBuildInputsChangedDuringCompile(evidence(), {
        ...evidence(),
        dependencies: [],
        truncated: true,
      }),
    ).toBe(false);
    expect(latexBuildInputsChangedDuringCompile(evidence(), evidence("unverified"))).toBe(false);
  });
  it("authorizes every LaTeX source extension mounted by the Visual surface", () => {
    const before = {
      ...evidence(),
      rootRelativePath: "main.latex",
      dependencies: [
        { path: "main.latex", sha256: "a".repeat(64), byteLength: 42 },
        { path: "chapter.ltx", sha256: "b".repeat(64), byteLength: 24 },
      ],
    };
    expect(latexVisualSourceRevisions(before, before)).toEqual({
      "main.latex": `sha256:${"a".repeat(64)}`,
      "chapter.ltx": `sha256:${"b".repeat(64)}`,
    });
  });
});
