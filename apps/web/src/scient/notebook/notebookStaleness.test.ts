import { describe, expect, it } from "vite-plus/test";

import type { NotebookCellView } from "@t3tools/contracts";

import { definedNames, notebookCodeHash, staleNotebookCells } from "./notebookStaleness";

const emptyCell: NotebookCellView = {
  id: "",
  cellType: "code",
  source: "",
  executionCount: null,
  run: null,
  pendingExecution: null,
  outputs: [],
};

const ran = (id: string, source: string, at: string, ranSource = source): NotebookCellView => ({
  ...emptyCell,
  id,
  source,
  run: { execution: `run-${id}`, code: notebookCodeHash(ranSource), at, ms: 10 },
});

describe("definedNames", () => {
  it("finds what a cell binds in Python, R, Julia and SQL", () => {
    expect([...definedNames("a, b = f()\nc += 1\nx == 2\n")]).toEqual(["a", "b", "c"]);
    expect(definedNames('df["x"] = 1').has("df")).toBe(true);
    expect(definedNames("df.loc[0] = 1").has("df")).toBe(true);
    expect(definedNames("fit <- lm(y ~ x)").has("fit")).toBe(true);
    expect(definedNames("import numpy as np, os").has("np")).toBe(true);
    expect(definedNames("from a.b import c as d, e").has("e")).toBe(true);
    expect(definedNames("function mean2(x)\nend").has("mean2")).toBe(true);
    expect(definedNames("for i, row in rows:\n  pass").has("row")).toBe(true);
    expect(definedNames("CREATE TABLE trials AS SELECT 1").has("trials")).toBe(true);
    expect(definedNames("# a = 1\nprint(1)").size).toBe(0);
  });
});

describe("staleNotebookCells", () => {
  it("is quiet after a clean top-to-bottom run", () => {
    const cells = [
      ran("1", "a = 1", "2026-10-30T10:00:00Z"),
      ran("2", "a + 1", "2026-10-30T10:00:01Z"),
    ];
    expect(staleNotebookCells(cells).size).toBe(0);
  });

  it("marks a cell edited since it ran, and the cells that read from it", () => {
    const cells = [
      ran("1", "a = 2", "2026-10-30T10:00:00Z", "a = 1"),
      ran("2", "b = a + 1", "2026-10-30T10:00:01Z"),
      ran("3", "print(b)", "2026-10-30T10:00:02Z"),
      ran("4", "print('other')", "2026-10-30T10:00:03Z"),
    ];
    expect(Object.fromEntries(staleNotebookCells(cells))).toEqual({
      "1": "edited",
      "2": "upstream",
      "3": "upstream",
    });
  });

  it("marks a cell when an earlier cell it reads ran after it", () => {
    const cells = [
      ran("1", "a = 1", "2026-10-30T11:00:00Z"),
      ran("2", "a + 1", "2026-10-30T10:00:00Z"),
    ];
    expect(staleNotebookCells(cells).get("2")).toBe("upstream");
  });

  it("ignores cells Scient has no run record for", () => {
    const foreign: NotebookCellView = { ...emptyCell, id: "1", source: "a = 1" };
    expect(staleNotebookCells([foreign, ran("2", "a", "2026-10-30T10:00:00Z")]).size).toBe(0);
  });
});
