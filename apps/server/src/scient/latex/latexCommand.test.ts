import { describe, expect, it } from "vite-plus/test";

import { buildLatexInvocation } from "./latexCommand.ts";

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
    expect(invocation.args).toContain("-halt-on-error");
    expect(invocation.args).toContain("-outdir=C:/state/scient-latex/abc");
    expect(invocation.args.at(-1)).toBe("C:\\work\\paper\\main.tex");
    expect(invocation.pdfPath).toBe("C:/state/scient-latex/abc/main.pdf");
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
      "/home/u/paper/thesis.tex",
    ]);
    expect(invocation.pdfPath).toBe("/state/scient-latex/xyz/thesis.pdf");
  });
});
