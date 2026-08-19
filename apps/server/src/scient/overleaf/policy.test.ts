import { describe, expect, it } from "vite-plus/test";

import { advisoryWarnings, normalizeManagedPath } from "./ManagedTree.ts";
import { parseNameStatus, parseUnmerged, uncertainPushWasAccepted } from "./OverleafMirror.ts";

describe("managed Overleaf path policy", () => {
  it("normalizes safe paths and rejects escapes, platform-invalid names, and .git", () => {
    expect(normalizeManagedPath("sections\\intro.tex")).toBe("sections/intro.tex");
    expect(normalizeManagedPath(".gitignore")).toBe(".gitignore");
    for (const path of [
      "../secret",
      "/absolute",
      "paper/.git/config",
      "CON.tex",
      "bad?.tex",
      "a//b",
    ]) {
      expect(() => normalizeManagedPath(path)).toThrow();
    }
  });

  it("treats documented size and count thresholds as blocking acknowledgements", () => {
    const files = Array.from({ length: 2_001 }, (_, index) => ({
      path: `chapters/${index}.tex`,
      hash: String(index),
      size: index === 0 ? 51 * 1024 * 1024 : 1,
      executable: false,
    }));
    const warnings = advisoryWarnings({
      files,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    });
    expect(warnings.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "file_count",
        "large_file",
        "large_editable_text",
        "large_editable_material",
      ]),
    );
    expect(warnings.every(({ blocking }) => blocking)).toBe(true);
  });
});

describe("Git machine-output parsing", () => {
  it("parses NUL-delimited additions, modifications, deletions, and 50% renames", () => {
    expect(parseNameStatus("A\0a.tex\0M\0b.tex\0D\0c.tex\0R050\0old.png\0new.png\0")).toEqual([
      { kind: "added", path: "a.tex" },
      { kind: "modified", path: "b.tex" },
      { kind: "deleted", path: "c.tex" },
      { kind: "renamed", oldPath: "old.png", path: "new.png", similarity: 50 },
    ]);
  });

  it("maps unmerged stages explicitly", () => {
    const output = [
      "100644 aaaaa 1\tmain.tex",
      "100644 bbbbb 2\tmain.tex",
      "100644 ccccc 3\tmain.tex",
      "",
    ].join("\0");
    expect(parseUnmerged(output)).toEqual([
      { mode: "100644", hash: "aaaaa", stage: 1, path: "main.tex" },
      { mode: "100644", hash: "bbbbb", stage: 2, path: "main.tex" },
      { mode: "100644", hash: "ccccc", stage: 3, path: "main.tex" },
    ]);
  });

  it("rejects truncated or unsupported name-status records", () => {
    for (const output of ["R050\0old.tex\0", "R999\0old.tex\0new.tex\0", "X\0path.tex\0"]) {
      expect(() => parseNameStatus(output)).toThrow();
    }
  });
});

describe("uncertain push recovery", () => {
  it("accepts recreated remote commits by tree identity", () => {
    expect(
      uncertainPushWasAccepted({
        candidateTree: "candidate-tree",
        headTree: "candidate-tree",
        firstParentTrees: [],
        candidateCommitReachable: false,
      }),
    ).toBe(true);
    expect(
      uncertainPushWasAccepted({
        candidateTree: "candidate-tree",
        headTree: "later-tree",
        firstParentTrees: ["later-tree", "candidate-tree"],
        candidateCommitReachable: false,
      }),
    ).toBe(true);
  });

  it("accepts preserved commits by reachability and rejects unrelated history", () => {
    expect(
      uncertainPushWasAccepted({
        candidateTree: "candidate-tree",
        headTree: "later-tree",
        firstParentTrees: ["later-tree"],
        candidateCommitReachable: true,
      }),
    ).toBe(true);
    expect(
      uncertainPushWasAccepted({
        candidateTree: "candidate-tree",
        headTree: "unrelated-tree",
        firstParentTrees: ["other-tree"],
        candidateCommitReachable: false,
      }),
    ).toBe(false);
  });
});
