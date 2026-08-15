import { describe, expect, it } from "vite-plus/test";

import {
  latexmkErrorSummary,
  parseLatexLog,
  summarizeLatexFailure,
  transcriptFailureDiagnostic,
} from "./latexLog.ts";

/**
 * What `latexmk` prints — verbatim, from the machine this was diagnosed on —
 * when it decides not to redo a target whose last run failed. It is the whole
 * of a failed compile's output: nothing here is `file:line:` shaped, nothing
 * here starts with `!`, and nothing here names a missing file. A build that
 * only reads TeX-shaped lines therefore reads this run as having said nothing
 * at all, which is exactly what happened in production.
 */
const REFUSED_RERUN_TRANSCRIPT = [
  "Initial Win CP for (console input, console output, system): (CP437, CP437, CP1252)",
  "I changed them all to CP1252",
  "Rc files read (in order):",
  "  NONE",
  "Latexmk: This is Latexmk, John Collins, 9 March 2026. Version 4.88.",
  "Latexmk: Nothing to do for 'C:/work/paper/main.tex'.",
  "Latexmk: All targets (C:/state/builds/abc/main.pdf) are up-to-date",
  "Collected error summary (may duplicate other messages):",
  "  pdflatex: gave an error in previous invocation of latexmk.",
  "",
  "Latexmk: Sometimes, the -f option can be used to get latexmk",
  "  to try to force complete processing.",
  "Reverting Windows console CPs to (in,out) = (437,437)",
  "C:/state/TinyTeX/bin/windows/runscript.tlu:933: command failed with exit code 12:",
  "perl.exe c:\\state\\TinyTeX\\texmf-dist\\scripts\\latexmk\\latexmk.pl -pdf C:/work/paper/main.tex",
].join("\n");

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

  it("ignores the TeX Live wrapper reporting the exit code of what it drove", () => {
    // Verbatim from a failed managed build: `runscript.tlu` announces the
    // status of the perl script it ran, in the same `file:line:` shape a real
    // error arrives in, and does it before the engine's own error is printed.
    const transcript = [
      'C:/Users/researcher/latex/managed/TinyTeX/bin/windows/runscript.tlu:933: command failed with exit code 12: perl.exe "C:/Users/researcher/latex/managed/TinyTeX/texmf-dist/scripts/latexmk/latexmk.pl" -pdf main.tex',
      "./main.tex:4: LaTeX Error: File `comment.sty' not found.",
      "",
    ].join("\n");

    const diagnostics = parseLatexLog(transcript);

    // The reader's problem is the missing package, at a file they can open.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", file: "main.tex", line: 4 });
    expect(summarizeLatexFailure(diagnostics)).toBe(
      "main.tex:4: LaTeX Error: File `comment.sty' not found.",
    );
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

describe("latexmkErrorSummary", () => {
  it("reads the driver's own verdict, which is all a refused rerun prints", () => {
    expect(latexmkErrorSummary(REFUSED_RERUN_TRANSCRIPT)).toBe(
      "pdflatex: gave an error in previous invocation of latexmk.",
    );
    expect(latexmkErrorSummary("This is pdfTeX\nOutput written on main.pdf (3 pages).")).toBeNull();
  });
});

describe("transcriptFailureDiagnostic", () => {
  it("gives a run that printed nothing TeX-shaped a reason anyway", () => {
    // The regression: this transcript parses to no diagnostics at all, and the
    // build used to record that as an empty list under "LaTeX build failed."
    expect(parseLatexLog(REFUSED_RERUN_TRANSCRIPT)).toEqual([]);
    expect(
      transcriptFailureDiagnostic({ transcript: REFUSED_RERUN_TRANSCRIPT, exitCode: 12 }),
    ).toEqual({
      severity: "error",
      file: null,
      line: null,
      message: "pdflatex: gave an error in previous invocation of latexmk.",
    });
  });

  it("quotes the tail when the run printed no summary of its own", () => {
    const diagnostic = transcriptFailureDiagnostic({
      transcript: ["Initial Win CP for (console input): (CP437)", "sh: pdflatex: killed"].join(
        "\n",
      ),
      exitCode: 137,
    });

    // The console chatter is the tooling talking about itself; the line that
    // says what happened is the one worth carrying.
    expect(diagnostic.message).toBe("sh: pdflatex: killed");
  });

  it("names the status when the run said nothing at all", () => {
    expect(transcriptFailureDiagnostic({ transcript: "", exitCode: 1 }).message).toBe(
      "The LaTeX engine exited with status 1 and reported nothing.",
    );
    expect(transcriptFailureDiagnostic({ transcript: "   \n\n", exitCode: null }).message).toBe(
      "The LaTeX engine was stopped before it reported anything.",
    );
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

  it("prefers the cause over latexmk's fatal-error verdict", () => {
    // The verdict is printed first and is the only error carrying a location,
    // so first-error-wins would report the summary instead of the reason.
    const summary = summarizeLatexFailure([
      {
        severity: "error",
        file: "main.tex",
        line: 4,
        message: "==> Fatal error occurred, no output PDF file produced!",
      },
      {
        severity: "error",
        file: null,
        line: null,
        message: "LaTeX Error: File `comment.sty' not found.",
      },
    ]);

    expect(summary).toBe("LaTeX Error: File `comment.sty' not found.");
  });

  it("still reports the fatal verdict when it is the only thing the run said", () => {
    expect(
      summarizeLatexFailure([
        {
          severity: "error",
          file: null,
          line: null,
          message: "==> Fatal error occurred, no output PDF file produced!",
        },
      ]),
    ).toBe("==> Fatal error occurred, no output PDF file produced!");
  });
});
