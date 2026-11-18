import { describe, expect, it } from "vite-plus/test";

import {
  csvTabularFile,
  defaultMacroName,
  escapeLatexText,
  outputSlug,
  parseCsv,
  uniqueMacroName,
  valuesTexFile,
} from "./latexOutputs.ts";

describe("macro names", () => {
  it("names a value by script and pointer, letters only", () => {
    expect(defaultMacroName("analysis/survival.py", "values.json", "/cohort/n")).toBe(
      "resultSurvivalCohortN",
    );
    expect(defaultMacroName("survival.py", "values.json", "/q1_hr")).toBe("resultSurvivalQOneHr");
    expect(defaultMacroName("fit.R", "stats.json", "/hr")).toBe("resultFitStatsHr");
    expect(defaultMacroName("1.py", "values.json", "/é")).toBe("resultOne");
    expect(defaultMacroName("_.py", "values.json", "/")).toBe("resultValue");
  });

  it("adds letters, never digits, to a taken name", () => {
    expect(uniqueMacroName("resultHr", new Set())).toBe("resultHr");
    expect(uniqueMacroName("resultHr", new Set(["resultHr", "resultHrB"]))).toBe("resultHrC");
  });
});

describe("escaping", () => {
  it("leaves numbers alone and escapes LaTeX specials", () => {
    expect(escapeLatexText("0.73")).toBe("0.73");
    expect(escapeLatexText("1,229")).toBe("1,229");
    expect(escapeLatexText("12% & <0.001")).toBe("12\\% \\& \\textless{}0.001");
    expect(escapeLatexText("a_b {c} ~^\\")).toBe(
      "a\\_b \\{c\\} \\textasciitilde{}\\textasciicircum{}\\textbackslash{}",
    );
    expect(escapeLatexText("\u22120.4")).toBe("\\textminus{}0.4");
  });
});

describe("values file", () => {
  it("writes one \\newcommand per value under a header", () => {
    const text = valuesTexFile({
      scriptPath: "analysis.py",
      revision: "rabcdefabcdef",
      finishedAt: "2026-11-18T10:00:00.000Z",
      values: [
        { macro: "resultAnalysisHr", value: "0.73" },
        { macro: "resultAnalysisP", value: "<0.001" },
      ],
    });
    expect(text).toContain("% Made by Scient from analysis.py, run rabcdefabcdef");
    expect(text).toContain("\\newcommand{\\resultAnalysisHr}{0.73}\n");
    expect(text).toContain("\\newcommand{\\resultAnalysisP}{\\textless{}0.001}\n");
  });
});

describe("CSV tables", () => {
  it("reads quoted cells, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('\uFEFFarm,n\r\n"Treatment, A",600\r\n"say ""hi""",5\n')).toEqual([
      ["arm", "n"],
      ["Treatment, A", "600"],
      ['say "hi"', "5"],
    ]);
  });

  it("refuses ragged rows and unterminated quotes", () => {
    expect(parseCsv("a,b\n1\n")).toBeNull();
    expect(parseCsv('a,b\n"1,2\n')).toBeNull();
    expect(parseCsv("")).toBeNull();
  });

  it("makes a booktabs tabular with numeric columns right-aligned", () => {
    const text = csvTabularFile({
      scriptPath: "analysis.py",
      revision: "rabcdefabcdef",
      finishedAt: "2026-11-18T10:00:00.000Z",
      rows: [
        ["Arm", "n", "Rate (%)"],
        ["Treatment", "600", "8.3%"],
        ["Control", "629", "11.1%"],
      ],
    });
    expect(text).toContain(
      "\\begin{tabular}{lrr}\n\\toprule\nArm & n & Rate (\\%) \\\\\n\\midrule\n",
    );
    expect(text).toContain("Treatment & 600 & 8.3\\% \\\\\n");
    expect(text).toMatch(/\\bottomrule\n\\end\{tabular\}\n$/u);
  });

  it("slugs output names for files and labels", () => {
    expect(outputSlug("tables/Table 1 (baseline).csv")).toBe("table-1-baseline");
    expect(outputSlug("é.csv")).toBe("e");
  });
});

describe("CSV edge cases", () => {
  it("keeps a quoted empty field at the end of a file without a final newline", () => {
    expect(parseCsv('a\n""')).toEqual([["a"], [""]]);
  });
});
