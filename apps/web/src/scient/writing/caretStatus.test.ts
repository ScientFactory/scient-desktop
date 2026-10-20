import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { CellSelection, tableNodes } from "prosemirror-tables";
import { describe, expect, it } from "vite-plus/test";

import { countSelectedWords, tableCaretPosition } from "./caretStatus";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: {},
    ...tableNodes({ tableGroup: "block", cellContent: "paragraph+", cellAttributes: {} }),
  },
});
const p = (text: string) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const cell = (text: string) => schema.node("table_cell", null, [p(text)]);
const row = (...cells: string[]) => schema.node("table_row", null, cells.map(cell));
const doc = schema.node("doc", null, [
  p("Before the table."),
  schema.node("table", null, [row("one", "two words"), row("three more words", "four")]),
]);
const cells: number[] = [];
doc.descendants((node, pos) => {
  if (node.type.name === "table_cell") cells.push(pos);
});

describe("what the footer says about the caret", () => {
  it("names the row and column of the cell the caret is in", () => {
    const at = (pos: number) =>
      tableCaretPosition(EditorState.create({ doc, selection: TextSelection.create(doc, pos) }));
    expect(at(2)).toBeNull();
    expect(at(cells[0]! + 2)).toBe("Table · row 1, column 1");
    expect(at(cells[1]! + 2)).toBe("Table · row 1, column 2");
    expect(at(cells[2]! + 2)).toBe("Table · row 2, column 1");
  });

  it("counts nothing for a bare caret and the words of a text selection", () => {
    expect(
      countSelectedWords(EditorState.create({ doc, selection: TextSelection.create(doc, 3) })),
    ).toBeNull();
    expect(
      countSelectedWords(EditorState.create({ doc, selection: TextSelection.create(doc, 1, 11) })),
    ).toBe(2);
  });

  it("counts every cell of a cell selection, not only the one it ends in", () => {
    const whole = CellSelection.create(doc, cells[0]!, cells[3]!);
    expect(countSelectedWords(EditorState.create({ doc, selection: whole }))).toBe(7);
    const column = CellSelection.create(doc, cells[1]!, cells[3]!);
    expect(countSelectedWords(EditorState.create({ doc, selection: column }))).toBe(3);
  });
});
