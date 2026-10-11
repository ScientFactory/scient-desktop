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

  it.each([
    ["% !TEX program = PDFTeX", "pdflatex"],
    ["%% !tex TS-program = XeTeX", "xelatex"],
    ["\t% !TEX program = LuaTeX --shell-escape", "lualatex"],
  ] as const)("recognizes the complete supported engine token in %s", (source, compiler) => {
    expect(declaredLatexCompiler(source)).toBe(compiler);
  });

  it.each(["xelatex-custom", "xelatex2", "pdflatex.exe", "luatex-next"])(
    "does not mistake unsupported engine %s for a supported prefix",
    (engine) => {
      const source = `% !TEX program = ${engine}\n${body}`;
      expect(latexCompilerDeclaration(source)).toBe(engine);
      expect(declaredLatexCompiler(source)).toBeNull();
    },
  );

  it("removes an EOF declaration without adding or stripping a body newline", () => {
    const source = "\\documentclass{article}\n% !TEX TS-program = xelatex";
    expect(updateLatexCompilerSource(source, "automatic")).toBe("\\documentclass{article}\n");
    expect(updateLatexCompilerSource(source, "pdflatex")).toBe(
      "% !TEX program = pdflatex\n\\documentclass{article}\n",
    );
  });

  it.each(["", "\\documentclass{article}", "\\documentclass{article}\r\n"])(
    "preserves the exact body when inserting and removing a directive in %j",
    (source) => {
      const changed = updateLatexCompilerSource(source, "lualatex");
      expect(updateLatexCompilerSource(changed, "automatic")).toBe(source);
      expect(updateLatexCompilerSource(changed, "lualatex")).toBe(changed);
    },
  );

  it("leaves root, near-match comments, and executable body text untouched", () => {
    const source = [
      "% !TEX root = main.tex",
      "% !TEX programmer = xelatex",
      "% TEX program = lualatex",
      "\\verb|% !TEX program = pdflatex|",
      "\\documentclass{article}",
    ].join("\n");
    expect(updateLatexCompilerSource(source, "automatic")).toBe(source);
    expect(updateLatexCompilerSource(source, "xelatex")).toBe(
      `% !TEX program = xelatex\n${source}`,
    );
  });

  it("recognizes and replaces a BOM-prefixed declaration without moving the BOM into the body", () => {
    const source = `\uFEFF% !TEX program = pdflatex\r\n% !TEX root = main.tex\r\n${body}`;
    expect(latexCompilerDeclaration(source)).toBe("pdflatex");
    expect(declaredLatexCompiler(source)).toBe("pdflatex");
    expect(updateLatexCompilerSource(source, "xelatex")).toBe(
      `\uFEFF% !TEX program = xelatex\r\n% !TEX root = main.tex\r\n${body}`,
    );
    expect(updateLatexCompilerSource(source, "automatic")).toBe(
      `\uFEFF% !TEX root = main.tex\r\n${body}`,
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
  const withAdditionalCompiler = {
    ...report,
    compilers: report.compilers.map((compiler) =>
      compiler.compiler === "lualatex"
        ? { ...compiler, available: true, executable: "/TinyTeX/bin/lualatex", version: "1.24.0" }
        : compiler,
    ),
  };
  expect(isLatexCompilerUnavailable(withAdditionalCompiler, "lualatex")).toBe(false);
  expect(isLatexCompilerUnavailable(withAdditionalCompiler, "pdflatex")).toBe(true);
});
