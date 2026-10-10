import { describe, expect, it } from "@effect/vitest";

import { manuscriptPathProblem, manuscriptTreeProblem } from "./manuscriptPaths.ts";

describe("manuscriptPathProblem", () => {
  it("accepts ordinary manuscript paths", () => {
    for (const path of [
      "main.tex",
      "sections/intro.tex",
      "figures/fig 1.pdf",
      "refs.bib",
      ".latexmkrc",
    ]) {
      expect(manuscriptPathProblem(path)).toBeNull();
    }
  });

  it("rejects paths that leave the folder or are not relative", () => {
    expect(manuscriptPathProblem("")).toBe("empty");
    expect(manuscriptPathProblem("/etc/passwd")).toBe("absolute");
    expect(manuscriptPathProblem("C:/x.tex")).toBe("absolute");
    expect(manuscriptPathProblem("a\\b.tex")).toBe("absolute");
    expect(manuscriptPathProblem("../x.tex")).toBe("traversal");
    expect(manuscriptPathProblem("a/./b.tex")).toBe("traversal");
    expect(manuscriptPathProblem("a//b.tex")).toBe("traversal");
  });

  it("rejects repository and Scient record folders at any depth", () => {
    expect(manuscriptPathProblem(".git/config")).toBe("reserved");
    expect(manuscriptPathProblem("sub/.GIT/hooks/pre-commit")).toBe("reserved");
    expect(manuscriptPathProblem(".scient/project.json")).toBe("reserved");
  });

  it("rejects names that cannot exist on every supported platform", () => {
    expect(manuscriptPathProblem("aux.tex")).toBe("invalid-on-a-supported-platform");
    expect(manuscriptPathProblem("notes.")).toBe("invalid-on-a-supported-platform");
    expect(manuscriptPathProblem("what?.tex")).toBe("invalid-on-a-supported-platform");
    expect(manuscriptPathProblem("line\nbreak.tex")).toBe("invalid-on-a-supported-platform");
  });
});

describe("manuscriptTreeProblem", () => {
  it("accepts a consistent tree", () => {
    expect(manuscriptTreeProblem(["main.tex", "sections/a.tex", "sections/b.tex"])).toBeNull();
  });

  it("rejects a path that is both a file and a folder", () => {
    expect(manuscriptTreeProblem(["section", "section/main.tex"])).toEqual({
      kind: "file-and-folder",
      file: "section",
      inside: "section/main.tex",
    });
  });

  it("rejects paths that differ only by letter case, including folders", () => {
    expect(manuscriptTreeProblem(["Main.tex", "main.tex"])?.kind).toBe("case-collision");
    expect(manuscriptTreeProblem(["Figures/a.pdf", "figures/b.pdf"])?.kind).toBe("case-collision");
  });

  it("rejects duplicates and unsafe paths", () => {
    expect(manuscriptTreeProblem(["a.tex", "a.tex"])).toEqual({ kind: "duplicate", path: "a.tex" });
    expect(manuscriptTreeProblem(["ok.tex", "../x"])).toEqual({
      kind: "path",
      path: "../x",
      problem: "traversal",
    });
  });
});

describe("Unicode path identity", () => {
  it.each([
    ["caf\u00e9.tex", "cafe\u0301.tex"],
    ["caf\u00e9/a.tex", "cafe\u0301/b.tex"],
    ["caf\u00e9", "cafe\u0301/intro.tex"],
    ["caf\u00e9/intro.tex", "cafe\u0301"],
    ["caf\u00e9/sub/a.tex", "cafe\u0301/sub/b.tex"],
  ])("rejects canonical aliases %s and %s", (first, second) => {
    expect(manuscriptTreeProblem([first, second])?.kind).toBe("normalization-collision");
    expect(manuscriptTreeProblem([second, first])?.kind).toBe("normalization-collision");
  });
  it("compares normalization together with letter case", () => {
    expect(manuscriptTreeProblem(["CAF\u00c9.tex", "cafe\u0301.tex"])?.kind).toBe("case-collision");
  });
  it("accepts either spelling on its own and preserves the caller's names", () => {
    const paths = ["cafe\u0301/intro.tex", "cafe\u0301/methods.tex"];
    expect(manuscriptTreeProblem(paths)).toBeNull();
    expect(paths).toEqual(["cafe\u0301/intro.tex", "cafe\u0301/methods.tex"]);
    expect(manuscriptTreeProblem(["caf\u00e9.tex", "cafe.tex"])).toBeNull();
  });
});

describe("full Unicode case folding", () => {
  it.each([
    ["straße.tex", "STRASSE.tex"],
    ["ﬁgure.tex", "figure.tex"],
    ["ß.tex", "ẞ.tex"],
    ["straße.tex", "STRAẞE.tex"],
    ["ς.tex", "Σ.tex"],
    ["ſ.tex", "S.tex"],
    ["K.tex", "k.tex"],
  ])("rejects aliases %s and %s in both orders and folder components", (a, b) => {
    for (const [first, second] of [
      [a, b],
      [b, a],
    ]) {
      expect(manuscriptTreeProblem([first!, second!])?.kind).toBe("case-collision");
      expect(manuscriptTreeProblem([`${first}/a.tex`, `${second}/b.tex`])?.kind).toBe(
        "case-collision",
      );
    }
  });
  it("does not conflate dotted and dotless i", () => {
    expect(manuscriptTreeProblem(["i.tex", "ı.tex"])).toBeNull();
    expect(manuscriptTreeProblem(["ı.tex", "i.tex"])).toBeNull();
  });
});
