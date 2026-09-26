import { describe, expect, it } from "@effect/vitest";

import {
  MAX_RECORDER_DEPENDENCIES,
  normalizePosixPath,
  parseLatexRecorderManifest,
  parseTectonicMakefileRules,
} from "./flsManifest.ts";

const POSIX = {
  workspaceRoot: "/home/u/workspace",
  compileDirectory: "/home/u/workspace/paper",
  workDirectory: "/home/u/.scient/userdata/latex/builds/abc123",
} as const;

const WINDOWS = {
  workspaceRoot: String.raw`C:\Users\u\workspace`,
  compileDirectory: String.raw`C:\Users\u\workspace\paper`,
  workDirectory: String.raw`C:\Users\u\AppData\scient\latex\builds\abc123`,
} as const;

describe("parseLatexRecorderManifest", () => {
  it("keeps the workspace inputs a run read and nothing else", () => {
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      contents: [
        "PWD /home/u/workspace/paper",
        "INPUT /usr/local/texlive/2026/texmf.cnf",
        "INPUT /usr/local/texlive/2026/tex/latex/base/article.cls",
        "INPUT main.tex",
        "INPUT sections/intro.tex",
        "INPUT ../shared/macros.sty",
        "INPUT figures/plot.pdf",
        "INPUT references.bib",
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "INPUT /home/u/.scient/userdata/latex/builds/abc123/main.aux",
        "",
      ].join("\n"),
    });

    // Sorted, deduplicated, and rebased on the workspace root — the shape a
    // client and a hash both need.
    expect(manifest).toEqual({
      truncated: false,
      dependencies: [
        "paper/figures/plot.pdf",
        "paper/main.tex",
        "paper/references.bib",
        "paper/sections/intro.tex",
        "shared/macros.sty",
      ],
    });
  });

  it("drops the distribution's own files and this run's own outputs", () => {
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      contents: [
        // Outside the workspace: the user cannot edit these and they only move
        // when the distribution does.
        "INPUT /usr/local/texlive/2026/tex/latex/geometry/geometry.sty",
        "INPUT /opt/fonts/lmroman10-regular.otf",
        // Written by this very run and read back on the next pass. Treated as
        // an input, every document would be permanently out of date.
        "INPUT /home/u/.scient/userdata/latex/builds/abc123/main.aux",
        "INPUT /home/u/.scient/userdata/latex/builds/abc123/main.toc",
        "INPUT main.tex",
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "",
      ].join("\n"),
    });

    expect(manifest.dependencies).toEqual(["paper/main.tex"]);
  });

  it("keeps POSIX containment case-sensitive", () => {
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      workspaceRoot: "/home/u/Workspace",
      compileDirectory: "/home/u/Workspace/paper",
      contents: [
        "INPUT /home/u/Workspace/paper/main.tex",
        "INPUT /home/u/workspace/other.tex",
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "",
      ].join("\n"),
    });

    expect(manifest.dependencies).toEqual(["paper/main.tex"]);
  });

  it("reads Windows paths, separators, and drive-letter case the way the recorder writes them", () => {
    const manifest = parseLatexRecorderManifest({
      ...WINDOWS,
      contents: [
        String.raw`PWD C:\Users\u\workspace\paper`,
        String.raw`INPUT c:\users\u\workspace\paper\main.tex`,
        String.raw`INPUT sections\intro.tex`,
        String.raw`INPUT C:\Users\u\AppData\scient\latex\builds\abc123\main.aux`,
        String.raw`INPUT C:\texlive\2026\tex\latex\base\article.cls`,
        String.raw`OUTPUT C:\Users\u\AppData\scient\latex\builds\abc123\main.pdf`,
        "",
      ].join("\n"),
    });

    // One filesystem, two spellings of the same drive: the containment test is
    // case-insensitive, and the path that comes back keeps the case on disk.
    expect(manifest.dependencies).toEqual(["paper/main.tex", "paper/sections/intro.tex"]);
  });

  it("compares Windows UNC roots case-insensitively", () => {
    const manifest = parseLatexRecorderManifest({
      workspaceRoot: String.raw`\\server\share\Workspace`,
      compileDirectory: String.raw`\\server\share\Workspace\paper`,
      workDirectory: String.raw`\\server\share\.scient\builds\abc123`,
      contents: [
        String.raw`INPUT \\SERVER\SHARE\workspace\paper\main.tex`,
        String.raw`OUTPUT \\server\share\.scient\builds\abc123\main.pdf`,
      ].join("\n"),
    });

    expect(manifest.dependencies).toEqual(["paper/main.tex"]);
  });

  it("falls back to a relative reading when the run declared no working directory", () => {
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      contents: [
        "INPUT main.tex",
        "INPUT sections/intro.tex",
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "",
      ].join("\n"),
    });

    expect(manifest.dependencies).toEqual(["paper/main.tex", "paper/sections/intro.tex"]);
  });

  it("gives up on a run with more inputs than it will stand behind", () => {
    const inputs = Array.from(
      { length: MAX_RECORDER_DEPENDENCIES + 1 },
      (_unused, index) => `INPUT chapters/chapter${String(index)}.tex`,
    );
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      contents: [
        ...inputs,
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "",
      ].join("\n"),
    });

    // Truncating to the first 256 would claim to be checking a document it is
    // only partly checking; the caller falls back to the root alone instead.
    expect(manifest).toEqual({ dependencies: [], truncated: true });
  });

  it("stays exactly at the ceiling without truncating", () => {
    const inputs = Array.from(
      { length: MAX_RECORDER_DEPENDENCIES },
      (_unused, index) => `INPUT chapters/chapter${String(index)}.tex`,
    );
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      contents: [
        ...inputs,
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "",
      ].join("\n"),
    });

    expect(manifest.truncated).toBe(false);
    expect(manifest.dependencies).toHaveLength(MAX_RECORDER_DEPENDENCIES);
  });

  it("fails closed on an empty, unrelated, or incomplete recorder", () => {
    expect(parseLatexRecorderManifest({ ...POSIX, contents: "" })).toEqual({
      dependencies: [],
      truncated: true,
    });
    expect(
      parseLatexRecorderManifest({ ...POSIX, contents: "This is pdfTeX, Version 3.14\n" }),
    ).toEqual({ dependencies: [], truncated: true });
    expect(parseLatexRecorderManifest({ ...POSIX, contents: "INPUT main.tex\n" })).toEqual({
      dependencies: [],
      truncated: true,
    });
  });

  it("never lets a recorded parent walk name a file outside the workspace", () => {
    const manifest = parseLatexRecorderManifest({
      ...POSIX,
      contents: [
        "INPUT ../../../etc/passwd",
        "INPUT ../../secrets.tex",
        "INPUT main.tex",
        "OUTPUT /home/u/.scient/userdata/latex/builds/abc123/main.pdf",
        "",
      ].join("\n"),
    });

    expect(manifest.dependencies).toEqual(["paper/main.tex"]);
  });
});

describe("parseTectonicMakefileRules", () => {
  it("keeps exact workspace inputs and drops generated targets and auxiliaries", () => {
    const manifest = parseTectonicMakefileRules({
      ...POSIX,
      contents: [
        "/home/u/.scient/userdata/latex/builds/abc123/main.synctex.gz \\",
        "  /home/u/.scient/userdata/latex/builds/abc123/main.pdf : main.tex \\",
        "  sections/intro.tex figures/plot\\ with\\ spaces.pdf \\",
        "  /home/u/.scient/userdata/latex/builds/abc123/results.out",
        "",
      ].join("\n"),
    });

    expect(manifest).toEqual({
      truncated: false,
      dependencies: [
        "paper/figures/plot with spaces.pdf",
        "paper/main.tex",
        "paper/results.out",
        "paper/sections/intro.tex",
      ],
    });
  });

  it("preserves literal Windows separators while decoding Make escapes", () => {
    const manifest = parseTectonicMakefileRules({
      ...WINDOWS,
      contents: String.raw`C:\Users\u\AppData\scient\latex\builds\abc123\main.pdf : main.tex sections\intro.tex`,
    });

    expect(manifest.dependencies).toEqual(["paper/main.tex", "paper/sections/intro.tex"]);
  });

  it("fails closed when no complete make rule was recorded", () => {
    expect(parseTectonicMakefileRules({ ...POSIX, contents: "" })).toEqual({
      dependencies: [],
      truncated: true,
    });
    expect(parseTectonicMakefileRules({ ...POSIX, contents: "main.pdf :\n" })).toEqual({
      dependencies: [],
      truncated: true,
    });
  });
});

describe("normalizePosixPath", () => {
  it("collapses separators and parent walks without consulting the disk", () => {
    expect(normalizePosixPath("/home/u/./paper/../workspace//main.tex")).toBe(
      "/home/u/workspace/main.tex",
    );
    expect(normalizePosixPath(String.raw`C:\work\paper\..\main.tex`)).toBe("C:/work/main.tex");
    // A walk above an absolute root has nowhere to go.
    expect(normalizePosixPath("/../../etc/passwd")).toBe("/etc/passwd");
    // A relative path keeps the walk it cannot resolve yet.
    expect(normalizePosixPath("../shared/macros.sty")).toBe("../shared/macros.sty");
  });
});
