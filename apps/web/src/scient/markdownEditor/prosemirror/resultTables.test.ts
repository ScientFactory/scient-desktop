import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";

import { editorResultReferences, resultTableSlice, updateResults } from "./results";
import { scientMarkdownParser, scientMarkdownSchema, scientMarkdownSerializer } from "./schema";

const FIRST = "scient-result:r0123456789ab/table1.csv";
const SECOND = "scient-result:rbbbbbbbbbbbb/table1.csv";

function paper() {
  const slice = resultTableSlice({
    href: FIRST,
    caption: "Table 1",
    rows: [
      ["Arm", "Patients", "Rate"],
      ["Treatment", "632", "2.01"],
      ["Control", "597", "2.76"],
    ],
  })!;
  return scientMarkdownSchema.node("doc", null, slice.content);
}

describe("linked result tables", () => {
  it("writes a table with a linked caption that reads back the same", () => {
    const doc = paper();
    const markdown = scientMarkdownSerializer.serialize(doc);
    expect(markdown).toBe(
      `| Arm | Patients | Rate |\n| --- | ---: | ---: |\n| Treatment | 632 | 2.01 |\n| Control | 597 | 2.76 |\n\nTable: [Table 1](${FIRST})`,
    );
    const reparsed = scientMarkdownParser.parse(markdown);
    expect(reparsed.eq(doc)).toBe(true);
    expect(editorResultReferences(reparsed)).toMatchObject([
      {
        kind: "table",
        href: FIRST,
        caption: "Table 1",
        rows: [
          ["Arm", "Patients", "Rate"],
          ["Treatment", "632", "2.01"],
          ["Control", "597", "2.76"],
        ],
      },
    ]);
  });

  it("moves a table and its caption to a newer run in one step", () => {
    const state = EditorState.create({ doc: paper() });
    const [table] = editorResultReferences(state.doc);
    if (table?.kind !== "table") throw new Error("no table");
    const transaction = updateResults(state, [
      {
        kind: "table",
        position: table.position,
        captionPosition: table.captionPosition,
        previousHref: table.href,
        href: SECOND,
        rows: [
          ["Arm", "Patients", "Rate"],
          ["Treatment", "611", "2.06"],
          ["Control", "567", "2.73"],
        ],
      },
    ])!;
    expect(scientMarkdownSerializer.serialize(transaction.doc)).toBe(
      `| Arm | Patients | Rate |\n| --- | ---: | ---: |\n| Treatment | 611 | 2.06 |\n| Control | 567 | 2.73 |\n\nTable: [Table 1](${SECOND})`,
    );
  });

  it("binds a table only to a caption line, not to a sentence that cites its file", () => {
    const sentence = scientMarkdownParser.parse(
      `| Arm |\n| --- |\n| A |\n\nSee [the table](${FIRST}) for counts.`,
    );
    expect(editorResultReferences(sentence).filter((ref) => ref.kind === "table")).toEqual([]);
    const caption = scientMarkdownParser.parse(`| Arm |\n| --- |\n| A |\n\n: [Arms](${FIRST})`);
    expect(editorResultReferences(caption)).toMatchObject([{ kind: "table", caption: "Arms" }]);
  });
});
