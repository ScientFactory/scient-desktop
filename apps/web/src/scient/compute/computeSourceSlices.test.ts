import { describe, expect, it } from "vite-plus/test";

import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@t3tools/contracts";

import {
  computeActiveCell,
  computeCell,
  computeCellQuote,
  computeFile,
  computeLineSelection,
  computeTextSelection,
  resolveComputeRunTarget,
} from "./computeSourceSlices";
import { MATLAB_COMPUTE_SOURCE } from "./computeSourceLanguage";

it("keeps MATLAB cell markers and exact source ranges language-owned", () => {
  const source = "%% first\nx = 1;\n%% second\ny = x + 2;";
  expect(computeCell(source, 4, MATLAB_COMPUTE_SOURCE.cellMarker)).toEqual({
    code: "y = x + 2;",
    range: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 10 },
  });
  expect(computeCell(source, 4)).toBeNull();
});

describe("the quote for a cell", () => {
  const quoted = (source: string, line: number) => {
    const range = computeCellQuote(source, line);
    return range === null ? null : source.slice(range.from, range.to);
  };

  it("is the cell's code, without the blank lines around it", () => {
    const source = "# %% one\n\nvalue = 1\nprint(value)\n\n\n# %% two\nother = 2\n";
    expect(quoted(source, 3)).toBe("value = 1\nprint(value)");
    expect(quoted(source, 5)).toBe("value = 1\nprint(value)");
    expect(quoted(source, 8)).toBe("other = 2");
  });

  it("starts from the cell below a marker line that was clicked", () => {
    expect(quoted("# %% one\nvalue = 1\n", 1)).toBe("value = 1");
  });

  it("does not exist outside a cell or for an empty one", () => {
    expect(quoted("preamble = 1\n# %%\nvalue = 2", 1)).toBeNull();
    expect(quoted("# %%\n\n# %%\nvalue = 2", 1)).toBeNull();
  });

  it("keeps the offsets of a file with Windows line ends", () => {
    expect(quoted("# %% one\r\nvalue = 1\r\nprint(value)\r\n", 2)).toBe(
      "value = 1\r\nprint(value)",
    );
  });

  it("quotes a cell too long for one from the clicked line, in whole lines", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `value_${index} = ${"x".repeat(40)}`);
    const source = ["# %%", ...lines, "# %%", "after = 1"].join("\n");
    const text = quoted(source, 301)!;
    expect(text.startsWith("value_299 = ")).toBe(true);
    expect(text.endsWith(lines[399]!)).toBe(true);

    const fromStart = quoted(source, 2)!;
    expect(fromStart.startsWith("value_0 = ")).toBe(true);
    expect(fromStart.length).toBeLessThanOrEqual(ASSISTANT_CITATION_MAX_TEXT_LENGTH);
    expect(lines).toContain(fromStart.split("\n").at(-1));
  });

  it("cuts a single line longer than a quote at the limit", () => {
    const source = `# %%\n${"x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 500)}\n`;
    expect(quoted(source, 2)).toHaveLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH);
  });
});

describe("Python editor execution slices", () => {
  const source = [
    "# %% imports",
    "import math",
    "",
    "# %% calculation",
    "value = math.sqrt(9)",
    "print(value)",
    "",
    "# %% empty",
  ].join("\n");

  it("submits the exact selected lines and normalizes a reverse selection", () => {
    expect(computeLineSelection(source, { start: 6, end: 5 })).toEqual({
      code: "value = math.sqrt(9)\nprint(value)",
      range: { startLine: 4, startColumn: 0, endLine: 5, endColumn: 12 },
    });
  });

  it("submits the current cell without its # %% markers", () => {
    expect(computeCell(source, 5)).toEqual({
      code: "value = math.sqrt(9)\nprint(value)\n",
      range: { startLine: 4, startColumn: 0, endLine: 6, endColumn: 0 },
    });
    expect(computeCell(source, 8)).toBeNull();
  });

  it("treats only a caret as the active cell visual target", () => {
    expect(
      computeActiveCell(source, {
        start: { line: 5, character: 2 },
        end: { line: 5, character: 2 },
      }),
    ).toMatchObject({
      code: "value = math.sqrt(9)\nprint(value)\n",
      range: { startLine: 4, endLine: 6 },
    });
    expect(
      computeActiveCell(source, {
        start: { line: 4, character: 0 },
        end: { line: 5, character: 3 },
      }),
    ).toBeNull();
  });

  it("requires an explicit marker before offering a cell", () => {
    expect(computeCell("value = 1\nprint(value)", 2)).toBeNull();
    expect(computeCell(["preamble = 1", "# %%", "value = 2"].join("\n"), 1)).toBeNull();
    expect(computeCell(["preamble = 1", "# %%", "value = 2"].join("\n"), 2)).toEqual({
      code: "value = 2",
      range: { startLine: 2, startColumn: 0, endLine: 2, endColumn: 9 },
    });
  });

  it("preserves exact partial-line editor selections", () => {
    expect(
      computeTextSelection("prefix = value + 1\nprint(prefix)", {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 18 },
      }),
    ).toEqual({
      code: "value + 1",
      range: { startLine: 0, startColumn: 9, endLine: 0, endColumn: 18 },
    });
    expect(
      computeTextSelection("one\ntwo\nthree", {
        start: { line: 2, character: 2 },
        end: { line: 0, character: 1 },
      }),
    ).toEqual({
      code: "ne\ntwo\nth",
      range: { startLine: 0, startColumn: 1, endLine: 2, endColumn: 2 },
    });
  });

  it("preserves current file bytes while reporting a zero-based source range", () => {
    expect(computeFile("x = 1\r\nprint(x)")).toEqual({
      code: "x = 1\r\nprint(x)",
      range: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 8 },
    });
  });

  it("chooses exact text, then an explicit cell, then the whole file", () => {
    expect(
      resolveComputeRunTarget(
        source,
        { start: 5, end: 6 },
        {
          start: { line: 4, character: 8 },
          end: { line: 4, character: 12 },
        },
      ),
    ).toMatchObject({ kind: "selection", slice: { code: "math" } });
    expect(
      resolveComputeRunTarget(source, null, {
        start: { line: 5, character: 2 },
        end: { line: 5, character: 2 },
      }),
    ).toMatchObject({
      kind: "cell",
      slice: { code: "value = math.sqrt(9)\nprint(value)\n" },
    });
    expect(
      resolveComputeRunTarget("value = 1\nprint(value)", null, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      }),
    ).toMatchObject({ kind: "file", slice: { code: "value = 1\nprint(value)" } });
  });

  it("keeps Unicode and CRLF bytes aligned with UTF-16 editor columns", () => {
    expect(computeLineSelection('α = "🧪"\r\nprint(α)\r\n', { start: 1, end: 2 })).toEqual({
      code: 'α = "🧪"\r\nprint(α)',
      range: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 8 },
    });
  });

  it("refuses empty selections and empty files", () => {
    expect(computeLineSelection("\n\n", { start: 1, end: 2 })).toBeNull();
    expect(computeFile("  \n")).toBeNull();
  });
});
