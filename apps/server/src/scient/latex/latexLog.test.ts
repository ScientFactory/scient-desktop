import { describe, expect, it } from "vite-plus/test";

import { parseLatexLog, summarizeLatexFailure } from "./latexLog.ts";

describe("parseLatexLog", () => {
  it("parses file-line errors with one continuation line", () => {
    const transcript = [
      "This is pdfTeX, Version 3.141592653",
      "./main.tex:12: Undefined control sequence.",
      "l.12 \\badcmd",
      "",
      "./sections\\intro.tex:3: Missing $ inserted.",
      "",
    ].join("\n");

    const diagnostics = parseLatexLog(transcript);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      file: "main.tex",
      line: 12,
    });
    expect(diagnostics[0]?.message).toContain("Undefined control sequence");
    expect(diagnostics[1]).toMatchObject({
      severity: "error",
      file: "sections/intro.tex",
      line: 3,
    });
  });

  it("parses bare bang errors without location", () => {
    const diagnostics = parseLatexLog("! Emergency stop.\n<*> main.tex\n");

    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      file: null,
      line: null,
      message: "Emergency stop.",
    });
  });

  it("parses multi-line warnings and extracts the input line", () => {
    const transcript = [
      "LaTeX Warning: Reference `fig:one' on page 1 undefined",
      "   on input line 42.",
      "",
      "Package hyperref Warning: Token not allowed in a PDF string.",
    ].join("\n");

    const diagnostics = parseLatexLog(transcript);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", line: 42 });
    expect(diagnostics[0]?.message).toContain("Reference `fig:one'");
    expect(diagnostics[1]).toMatchObject({ severity: "warning", line: null });
  });

  it("bounds diagnostic count and message length", () => {
    const noisy = Array.from(
      { length: 500 },
      (_, i) => `./f.tex:${i + 1}: ${"x".repeat(900)}`,
    ).join("\n\n");

    const diagnostics = parseLatexLog(noisy);

    expect(diagnostics.length).toBeLessThanOrEqual(200);
    expect((diagnostics[0]?.message ?? "").length).toBeLessThanOrEqual(500);
  });

  it("returns nothing for a clean transcript", () => {
    expect(parseLatexLog("Output written on main.pdf (3 pages).\n")).toHaveLength(0);
  });

  it("ignores the aux files a cold build reports missing before writing them", () => {
    const transcript = [
      "No file main.aux.",
      "No file main.toc.",
      "No file paper/main.bbl.",
      "No file main.synctex.gz.",
      "No file chapters/intro.tex.",
    ].join("\n");

    const diagnostics = parseLatexLog(transcript);

    // Only the real source file is missing; the rest the engine creates itself.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "warning",
      file: "chapters/intro.tex",
    });
  });

  it("reads a tectonic transcript whose lines carry a severity label", () => {
    // Verbatim shape of tectonic's forwarded TeX output.
    const transcript = [
      "Running TeX ...",
      "error: main.tex:12: Undefined control sequence.",
      "l.12 \\nosuchmacro",
      "",
      "warning: sections/intro.tex:3: Overfull \\hbox (12.0pt too wide).",
      "error: the LaTeX engine failed (exit status 1)",
    ].join("\n");

    const diagnostics = parseLatexLog(transcript);

    // The label must never end up inside the file capture.
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      file: "main.tex",
      line: 12,
    });
    expect(diagnostics[0]?.message).toContain("Undefined control sequence");
    expect(diagnostics[1]).toMatchObject({
      severity: "warning",
      file: "sections/intro.tex",
      line: 3,
    });
  });

  it("keeps a long message whole now that builds raise max_print_line", () => {
    // TeX wraps at 79 columns unless `max_print_line` says otherwise, which
    // used to split one error across lines; the service sets it, so the
    // transcript arrives unwrapped and the message survives in one piece.
    const message = `Undefined control sequence \\${"verylongmacroname".repeat(4)} in the preamble.`;
    const diagnostics = parseLatexLog(`./main.tex:12: ${message}\n\n`);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe(message);
    expect((diagnostics[0]?.message ?? "").length).toBeGreaterThan(79);
  });
});

describe("summarizeLatexFailure", () => {
  it("names the first error's location", () => {
    const summary = summarizeLatexFailure([
      { severity: "warning", file: null, line: null, message: "minor" },
      { severity: "error", file: "main.tex", line: 12, message: "Undefined control sequence." },
    ]);

    expect(summary).toBe("main.tex:12: Undefined control sequence.");
  });

  it("falls back to a generic summary without errors", () => {
    expect(summarizeLatexFailure([])).toBe("LaTeX build failed.");
  });
});
