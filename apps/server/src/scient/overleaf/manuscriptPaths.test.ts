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
