import { describe, expect, it } from "vite-plus/test";
import { insertMatrix, matrixAt, matrixEdit, type MatrixEnvironment } from "./matrix";

const environments = ["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"] as const;
const gaps = (source: string) => source.match(/\\\\\[0\.12\s*em\]/gu)?.length ?? 0;

describe("display matrix row spacing", () => {
  it.each(environments)(
    "spaces new display %s without changing inline insertion",
    (environment) => {
      for (let rows = 1; rows <= 20; rows++) {
        for (let columns = 1; columns <= 20; columns++) {
          const display = insertMatrix({ from: 0, to: 0 }, environment, rows, columns, true)!;
          const inline = insertMatrix({ from: 0, to: 0 }, environment, rows, columns, false)!;
          expect(gaps(display.insert)).toBe(rows - 1);
          expect(gaps(inline.insert)).toBe(0);
          const parsed = matrixAt(display.insert, display.selection.from)!;
          expect(parsed.rows.map((row) => row.length)).toEqual(
            Array.from({ length: rows }, () => columns),
          );
          for (const cell of parsed.rows.flat())
            expect(display.insert.slice(cell.from, cell.to).trim()).toBe("{}");
        }
      }
    },
  );

  it.each(["smallmatrix", "cases", "aligned"] as const)("keeps %s compact", (environment) => {
    expect(insertMatrix({ from: 0, to: 0 }, environment, 3, 2, true)?.insert).not.toContain(
      "[0.12em]",
    );
  });

  it("preserves spacing through every source matrix action and a MathLive round trip", () => {
    for (const action of [
      "addRow",
      "copyRow",
      "deleteRow",
      "swapRow",
      "addColumn",
      "copyColumn",
      "deleteColumn",
      "swapColumn",
    ] as const) {
      const inserted = insertMatrix({ from: 0, to: 0 }, "bmatrix", 3, 3, true)!;
      // MathLive emits a space between the dimension and unit.
      const source = inserted.insert.replaceAll("0.12em", "0.12 em");
      const edit = matrixEdit(source, inserted.selection, action)!;
      const updated = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
      const parsed = matrixAt(updated, edit.selection.from)!;
      expect(gaps(updated)).toBe(parsed.rows.length - 1);
      expect(updated[edit.selection.from - 1]).toBe("{");
      expect(updated[edit.selection.from]).toBe("}");
    }
  });

  it("does not reinterpret author-defined, mixed, or malformed spacing", () => {
    for (const gap of ["2pt", "0em", "-0.12em", "0.2em", "\\baselineskip", "0.12em extra"]) {
      const source = `\\begin{bmatrix}a&b\\\\[${gap}]c&d\\end{bmatrix}`;
      expect(matrixEdit(source, { from: 16, to: 16 }, "addRow")).toBeNull();
    }
    const mixed = String.raw`\begin{bmatrix}a&b\\[0.12em]c&d\\e&f\end{bmatrix}`;
    expect(matrixAt(mixed, mixed.indexOf("a&b"))).toBeNull();
    for (const environment of environments as readonly MatrixEnvironment[]) {
      const inserted = insertMatrix({ from: 0, to: 0 }, environment, 3, 3)!;
      const edit = matrixEdit(inserted.insert, inserted.selection, "addRow")!;
      expect(gaps(edit.insert)).toBe(0);
    }
  });

  it("preserves populated cells and their targets through spaced source edits", () => {
    const source = String.raw`\begin{bmatrix}a&b\\[0.12em]c&d\end{bmatrix}`;
    const selection = { from: source.indexOf("a&"), to: source.indexOf("a&") };
    const expected = {
      addRow: [
        ["a", "b"],
        ["{}", "{}"],
        ["c", "d"],
      ],
      copyRow: [
        ["a", "b"],
        ["a", "b"],
        ["c", "d"],
      ],
      deleteRow: [["c", "d"]],
      swapRow: [
        ["c", "d"],
        ["a", "b"],
      ],
      addColumn: [
        ["a", "{}", "b"],
        ["c", "{}", "d"],
      ],
      copyColumn: [
        ["a", "a", "b"],
        ["c", "c", "d"],
      ],
      deleteColumn: [["b"], ["d"]],
      swapColumn: [
        ["b", "a"],
        ["d", "c"],
      ],
    };
    for (const action of Object.keys(expected) as (keyof typeof expected)[]) {
      const edit = matrixEdit(source, selection, action)!;
      const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
      const parsed = matrixAt(next, edit.selection.from)!;
      expect(
        parsed.rows.map((row) => row.map((cell) => next.slice(cell.from, cell.to).trim())),
      ).toEqual(expected[action]);
      expect(gaps(next)).toBe(expected[action].length - 1);
      expect(
        parsed.rows
          .flat()
          .some((cell) => edit.selection.from >= cell.from && edit.selection.to <= cell.to),
      ).toBe(true);
    }
  });

  it("does not confuse nested matrix gaps with the outer row separators", () => {
    const source = String.raw`\begin{bmatrix}a&\begin{pmatrix}x\\[0.12em]y\end{pmatrix}\\[0.12em]c&d\end{bmatrix}`;
    const outer = matrixAt(source, source.indexOf("a&"))!;
    expect(outer.rows.map((row) => row.length)).toEqual([2, 2]);
    expect(matrixAt(source, source.indexOf("x\\\\"))?.rows.map((row) => row.length)).toEqual([
      1, 1,
    ]);
  });
  it("creates the first separator consistently after a display matrix shrinks to one row", () => {
    const inserted = insertMatrix({ from: 0, to: 0 }, "bmatrix", 2, 2, true)!;
    const shrink = matrixEdit(inserted.insert, inserted.selection, "deleteRow", true)!;
    const single =
      inserted.insert.slice(0, shrink.from) + shrink.insert + inserted.insert.slice(shrink.to);
    expect(gaps(single)).toBe(0);
    const display = matrixEdit(single, shrink.selection, "addRow", true)!;
    const inline = matrixEdit(single, shrink.selection, "addRow", false)!;
    expect(gaps(display.insert)).toBe(1);
    expect(gaps(inline.insert)).toBe(0);
  });
});
