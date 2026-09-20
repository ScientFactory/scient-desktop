import { describe, expect, it } from "@effect/vitest";
import { latexVisualSourceRevisions, type LatexBuildEvidence } from "./latexBuildEvidence.ts";

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
});
