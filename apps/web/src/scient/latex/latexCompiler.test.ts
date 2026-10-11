import { describe, expect, it } from "vite-plus/test";
import type { ScientLatexToolchainReport } from "@t3tools/contracts";

import {
  declaredLatexCompiler,
  latexCompilerDeclaration,
  isLatexCompilerUnavailable,
  updateLatexCompilerSource,
} from "./latexCompiler";

const body = "\\documentclass{article}\r\n\\begin{document}\r\nשלום $x=1$\r\n\\end{document}\r\n";

describe("document compiler directives", () => {
  it("replaces conflicting editor declarations without changing the body or root directive", () => {
    const source = `% !TEX root = main.tex\r\n %%!tex TS-program = XeTeX\r\n% !TEX program = pdflatex\r\n${body}`;
    const changed = updateLatexCompilerSource(source, "lualatex");
    expect(changed).toBe(`% !TEX program = lualatex\r\n% !TEX root = main.tex\r\n${body}`);
    expect(declaredLatexCompiler(changed)).toBe("lualatex");
  });

  it("returns to automatic resolution without removing unrelated comments", () => {
    const source = `% !TEX program = xelatex\n% Hebrew document\n\\usepackage{fontspec}\n`;
    expect(updateLatexCompilerSource(source, "automatic")).toBe(
      "% Hebrew document\n\\usepackage{fontspec}\n",
    );
    expect(declaredLatexCompiler(updateLatexCompilerSource(source, "automatic"))).toBeNull();
  });

  it("keeps unsupported declarations observable until the person deliberately changes them", () => {
    const source = `% !TEX program = context\n${body}`;
    expect(latexCompilerDeclaration(source)).toBe("context");
    expect(declaredLatexCompiler(source)).toBeNull();
    expect(updateLatexCompilerSource(source, "xelatex")).toBe(
      `% !TEX program = xelatex\r\n${body}`,
    );
  });
});

it("keeps Tectonic's XeTeX path usable without claiming standalone compilers are installed", () => {
  const report: ScientLatexToolchainReport = {
    kind: "tectonic",
    executable: "tectonic",
    version: "0.15.0",
    probedAtEpochMs: 1,
    canInstallManaged: true,
    compilers: (["pdflatex", "xelatex", "lualatex"] as const).map((compiler) => ({
      compiler,
      available: false,
      executable: null,
      version: null,
    })),
  };
  expect(isLatexCompilerUnavailable(report, "xelatex")).toBe(false);
  expect(isLatexCompilerUnavailable(report, "pdflatex")).toBe(true);
  expect(isLatexCompilerUnavailable(report, "lualatex")).toBe(true);
  expect(isLatexCompilerUnavailable({ ...report, kind: "latexmk" }, "xelatex")).toBe(true);
});
