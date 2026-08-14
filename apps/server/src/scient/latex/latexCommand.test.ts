import { describe, expect, it } from "vite-plus/test";

import { buildLatexInvocation, latexEngineEnvironment } from "./latexCommand.ts";

describe("buildLatexInvocation", () => {
  it("builds a safe non-interactive latexmk invocation", () => {
    const invocation = buildLatexInvocation({
      toolchain: { kind: "latexmk", executable: "latexmk", version: "4.86" },
      rootAbsolutePath: "C:\\work\\paper\\main.tex",
      workDirectory: "C:/state/scient-latex/abc",
    });

    expect(invocation.command).toBe("latexmk");
    expect(invocation.args).toContain("-interaction=nonstopmode");
    expect(invocation.args).toContain("-file-line-error");
    expect(invocation.args).toContain("-no-shell-escape");
    expect(invocation.args).toContain("-synctex=1");
    expect(invocation.args).toContain("-outdir=C:/state/scient-latex/abc");
    expect(invocation.args.at(-1)).toBe("C:\\work\\paper\\main.tex");
    expect(invocation.pdfPath).toBe("C:/state/scient-latex/abc/main.pdf");
  });

  it("runs to the end of the document instead of halting on the first error", () => {
    const invocation = buildLatexInvocation({
      toolchain: { kind: "latexmk", executable: "latexmk", version: "4.86" },
      rootAbsolutePath: "/home/u/paper/main.tex",
      workDirectory: "/state/scient-latex/abc",
    });

    // Overleaf parity: an error-carrying document still typesets a PDF, and the
    // service publishes it with the errors beside it.
    expect(invocation.args).not.toContain("-halt-on-error");
  });

  it("keeps a subdirectory root addressable from its own directory", () => {
    const invocation = buildLatexInvocation({
      toolchain: { kind: "latexmk", executable: "latexmk", version: "4.86" },
      rootAbsolutePath: "/home/u/workspace/paper/main.tex",
      workDirectory: "/state/scient-latex/abc",
    });

    // The engine is spawned from the root's own directory so `\input` resolves,
    // and the absolute root plus an absolute `-outdir` survive that cwd.
    expect(invocation.args.at(-1)).toBe("/home/u/workspace/paper/main.tex");
    expect(invocation.args).toContain("-outdir=/state/scient-latex/abc");
    expect(invocation.pdfPath).toBe("/state/scient-latex/abc/main.pdf");
  });

  it("forces latexmk to reprocess a target it has already failed on", () => {
    // `latexmk` records in the work directory's `.fdb_latexmk` both that the
    // last run failed and which files it could not find, at the paths it
    // looked in. Installing the package puts the file somewhere else entirely,
    // so nothing `latexmk` watches has changed: without `-g` the retry reports
    // "Nothing to do", never runs the engine, and exits non-zero with only its
    // own prose — a document that was just given its package looking exactly
    // like one that still has not got it.
    const forced = buildLatexInvocation({
      toolchain: { kind: "latexmk", executable: "latexmk", version: "4.88" },
      rootAbsolutePath: "/home/u/paper/main.tex",
      workDirectory: "/state/scient-latex/abc",
      forceReprocess: true,
    });
    expect(forced.args).toContain("-g");
    expect(forced.args.at(-1)).toBe("/home/u/paper/main.tex");

    expect(
      buildLatexInvocation({
        toolchain: { kind: "latexmk", executable: "latexmk", version: "4.88" },
        rootAbsolutePath: "/home/u/paper/main.tex",
        workDirectory: "/state/scient-latex/abc",
      }).args,
    ).not.toContain("-g");
  });

  it("builds an untrusted tectonic invocation", () => {
    const invocation = buildLatexInvocation({
      toolchain: { kind: "tectonic", executable: "tectonic", version: "0.15" },
      rootAbsolutePath: "/home/u/paper/thesis.tex",
      workDirectory: "/state/scient-latex/xyz",
    });

    expect(invocation.command).toBe("tectonic");
    expect(invocation.args).toEqual([
      "--outdir",
      "/state/scient-latex/xyz",
      "--untrusted",
      "--synctex",
      "/home/u/paper/thesis.tex",
    ]);
    expect(invocation.pdfPath).toBe("/state/scient-latex/xyz/thesis.pdf");

    // tectonic keeps no cross-run decision state, so there is nothing to force.
    expect(
      buildLatexInvocation({
        toolchain: { kind: "tectonic", executable: "tectonic", version: "0.15" },
        rootAbsolutePath: "/home/u/paper/thesis.tex",
        workDirectory: "/state/scient-latex/xyz",
        forceReprocess: true,
      }).args,
    ).toEqual(invocation.args);
  });
});

describe("latexEngineEnvironment", () => {
  const base = { max_print_line: "1000" } as const;

  it("leaves the environment alone for an engine already on PATH", () => {
    expect(
      latexEngineEnvironment({
        base,
        hostEnvironment: { PATH: "/usr/bin" },
        binDirectory: null,
        pathDelimiter: ":",
      }),
    ).toBe(base);
  });

  it("leads PATH with the managed distribution so latexmk finds its own engines", () => {
    expect(
      latexEngineEnvironment({
        base,
        hostEnvironment: { PATH: "/usr/bin:/bin" },
        binDirectory: "/state/latex/managed/tinytex-2026.08/TinyTeX/bin/x86_64-linux",
        pathDelimiter: ":",
      }),
    ).toEqual({
      max_print_line: "1000",
      PATH: "/state/latex/managed/tinytex-2026.08/TinyTeX/bin/x86_64-linux:/usr/bin:/bin",
    });
  });

  it("reuses the spelling Windows already has instead of adding a second one", () => {
    const managedBin = String.raw`C:\state\latex\managed\tinytex\TinyTeX\bin\windows`;
    const systemPath = String.raw`C:\Windows\system32`;
    const environment = latexEngineEnvironment({
      base,
      hostEnvironment: { Path: systemPath },
      binDirectory: managedBin,
      pathDelimiter: ";",
    });

    expect(environment.Path).toBe(`${managedBin};${systemPath}`);
    // A second spelling would leave the child process with two PATHs.
    expect(Object.keys(environment)).not.toContain("PATH");
  });

  it("still leads with the managed distribution when the host has no PATH at all", () => {
    expect(
      latexEngineEnvironment({
        base,
        hostEnvironment: {},
        binDirectory: "/opt/tinytex/bin",
        pathDelimiter: ":",
      }),
    ).toEqual({ max_print_line: "1000", PATH: "/opt/tinytex/bin" });
  });
});
