import { describe, expect, it } from "vite-plus/test";
import type { Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";

import { createScientMarkdownProjection, serializeScientMarkdownProjection } from "./projection";
import { listKindAt, runScientMarkdownCommand, type ScientMarkdownCommand } from "./commands";
import { ScientProseMirrorSession } from "./session";

function runUserCommand(session: ScientProseMirrorSession, command: ScientMarkdownCommand): void {
  runScientMarkdownCommand(command, session.state, (transaction: Transaction) => {
    session.applyTransaction(transaction, "user");
  });
}

function select(session: ScientProseMirrorSession, from: number, to = from): void {
  session.applyTransaction(
    session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)),
    "user",
  );
}

describe("Scient Markdown commands", () => {
  it("round-trips a right-to-left paragraph through the div convention", () => {
    const source = "Hello  world.\n\nSecond paragraph.\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    select(session, 1); // inside the first paragraph
    runUserCommand(session, "direction-rtl");

    expect(session.session.draftSource).toBe(
      '<div dir="rtl">\n\nHello  world.\n\n</div>\n\nSecond paragraph.\n',
    );

    const reparsed = createScientMarkdownProjection(session.session.draftSource);
    expect(reparsed.document.firstChild?.attrs.dir).toBe("rtl");
    expect(reparsed.document.child(1)?.attrs.dir).toBeNull();
    expect(serializeScientMarkdownProjection(reparsed, reparsed.document)).toBe(
      session.session.draftSource,
    );
  });

  it("parses an existing direction wrapper and resets direction to auto", () => {
    const source = '<div dir="rtl">\n\nمرحبا بالعالم.\n\n</div>\n\nNormal  text.\n';
    const session = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    expect(session.state.doc.firstChild?.attrs.dir).toBe("rtl");
    expect(session.state.doc.child(1)?.attrs.dir).toBeNull();

    select(session, session.state.doc.content.size - 2); // inside "Normal  text."
    runUserCommand(session, "direction-rtl");
    expect(session.session.draftSource).toContain("مرحبا بالعالم.");
    expect(
      session.session.draftSource.endsWith('<div dir="rtl">\n\nNormal  text.\n\n</div>\n'),
    ).toBe(true);

    runUserCommand(session, "direction-auto");
    expect(session.session.draftSource.endsWith("\n\nNormal  text.\n")).toBe(true);
    expect(session.state.doc.firstChild?.attrs.dir).toBe("rtl");
  });

  it("applies direction to a heading and every paragraph in the selection", () => {
    const source = "# Title\n\nFirst.\n\nSecond.\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    select(session, 2, session.state.doc.content.size - 1);
    runUserCommand(session, "direction-ltr");

    expect(session.state.doc.firstChild?.attrs.dir).toBe("ltr");
    expect(session.session.draftSource).toBe(
      '<div dir="ltr">\n\n# Title\n\n</div>\n\n<div dir="ltr">\n\nFirst.\n\n</div>\n\n<div dir="ltr">\n\nSecond.\n\n</div>\n',
    );
  });

  it("toggles a task list with the checkbox set and untoggles on repeat", () => {
    const session = new ScientProseMirrorSession({ source: "Buy milk\n", revision: "sha256:b" });
    select(session, 1);
    runUserCommand(session, "task-list");

    const list = session.state.doc.firstChild;
    expect(list?.type.name).toBe("bullet_list");
    expect(list?.child(0).attrs.taskChecked).toBe(true);
    expect(listKindAt(session.state)).toBe("task");
    expect(session.session.draftSource).toBe("- [x] Buy milk\n");

    runUserCommand(session, "task-list");
    expect(session.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(listKindAt(session.state)).toBeNull();
    expect(session.session.draftSource).toBe("Buy milk\n");
  });

  it("untoggles a bullet list when the same kind is applied again", () => {
    const source = "- alpha\n- beta\n\nAfter.\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:b" });
    select(session, 3);
    expect(listKindAt(session.state)).toBe("bullet");

    runUserCommand(session, "bullet-list");
    expect(listKindAt(session.state)).toBeNull();
    expect(session.session.draftSource).toBe("alpha\n\n- beta\n\nAfter.\n");

    runUserCommand(session, "list-none");
    expect(session.session.draftSource).toBe("alpha\n\n- beta\n\nAfter.\n");
  });

  it("wraps several selected paragraphs as checked task items", () => {
    const source = "one\n\ntwo\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:b" });
    select(session, 1, session.state.doc.content.size - 1);

    runUserCommand(session, "task-list");
    expect(listKindAt(session.state)).toBe("task");
    expect(session.session.draftSource).toBe("- [x] one\n- [x] two\n");
  });

  it("inserts a hard break that serializes as a backslash line break", () => {
    const session = new ScientProseMirrorSession({ source: "alpha beta\n", revision: "sha256:b" });
    select(session, 7); // between "alpha " and "beta"
    runUserCommand(session, "hard-break");

    expect(session.session.draftSource).toBe("alpha \\\nbeta\n");

    const reparsed = createScientMarkdownProjection(session.session.draftSource);
    expect(serializeScientMarkdownProjection(reparsed, reparsed.document)).toBe(
      session.session.draftSource,
    );
  });

  it("clears character formatting in the selection", () => {
    const source = "Bold **words** and ~~struck~~ text.\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:b" });
    select(session, 1, session.state.doc.content.size - 1);
    runUserCommand(session, "clear-formatting");

    expect(session.session.draftSource).toBe("Bold words and struck text.\n");
  });

  it("supports heading levels up to six", () => {
    const session = new ScientProseMirrorSession({
      source: "Deep  heading.\n",
      revision: "sha256:b",
    });
    select(session, 1);
    runUserCommand(session, "heading-6");
    expect(session.state.doc.firstChild?.type.name).toBe("heading");
    expect(session.state.doc.firstChild?.attrs.level).toBe(6);
    expect(session.session.draftSource).toBe("###### Deep  heading.\n");
  });
});

/** Every control in the editing dock must land a real document change. */
describe("Scient Markdown dock command coverage", () => {
  const freshSession = (source = "") =>
    new ScientProseMirrorSession({ source, revision: "sha256:b" });

  it("applies inline marks to the selection", () => {
    const cases: ReadonlyArray<readonly [ScientMarkdownCommand, string]> = [
      ["bold", "Some **text** here.\n"],
      ["italic", "Some *text* here.\n"],
      ["strike", "Some ~~text~~ here.\n"],
      ["inline-code", "Some `text` here.\n"],
    ];
    for (const [command, expected] of cases) {
      const session = freshSession("Some text here.\n");
      select(session, 6, 10);
      runUserCommand(session, command);
      expect(session.session.draftSource).toBe(expected);
    }
  });

  it("inserts block elements at the caret", () => {
    const cases: ReadonlyArray<readonly [ScientMarkdownCommand, string]> = [
      ["horizontal-rule", "---"],
      ["image", "!["],
      ["wiki-link", "[[Untitled]]"],
      ["display-math", "$$"],
      ["code-block", "```"],
    ];
    for (const [command, marker] of cases) {
      const session = freshSession();
      select(session, 1);
      runUserCommand(session, command);
      expect(session.session.draftSource).toContain(marker);
    }
  });

  it("inserts a three-by-three table", () => {
    const session = freshSession();
    select(session, 1);
    runUserCommand(session, "table");
    const table = session.state.doc.firstChild;
    expect(table?.type.name).toBe("table");
    expect(table?.childCount).toBe(3);
    expect(table?.firstChild?.childCount).toBe(3);
    expect(session.session.draftSource).toContain("| --- | --- | --- |");
  });

  it("toggles an ordered list on and off", () => {
    const session = freshSession("Item.\n");
    select(session, 1);
    runUserCommand(session, "ordered-list");
    expect(session.session.draftSource).toBe("1. Item.\n");
    expect(listKindAt(session.state)).toBe("ordered");

    runUserCommand(session, "ordered-list");
    expect(session.session.draftSource).toBe("Item.\n");
    expect(listKindAt(session.state)).toBeNull();
  });

  function tableSession(): { readonly session: ScientProseMirrorSession } {
    const session = freshSession();
    select(session, 1);
    runUserCommand(session, "table");
    let cellPosition = -1;
    session.state.doc.descendants((node, position) => {
      if (node.type.name === "table_cell" && cellPosition < 0) cellPosition = position;
      return node.type.name !== "table_cell";
    });
    select(session, cellPosition + 2);
    return { session };
  }

  it("edits table alignment, structure, and headers", () => {
    const { session } = tableSession();

    runUserCommand(session, "align-column-left");
    expect(session.session.draftSource).toContain(":---");
    runUserCommand(session, "align-column-center");
    expect(session.session.draftSource).toContain(":---:");
    runUserCommand(session, "align-column-right");
    expect(session.session.draftSource).toContain("---:");
    runUserCommand(session, "align-column-default");
    expect(session.session.draftSource).not.toContain(":");

    const table = () => session.state.doc.firstChild;
    runUserCommand(session, "add-row-after");
    expect(table()?.childCount).toBe(4);
    runUserCommand(session, "add-row-before");
    expect(table()?.childCount).toBe(5);
    runUserCommand(session, "delete-row");
    expect(table()?.childCount).toBe(4);

    runUserCommand(session, "add-column-after");
    expect(table()?.firstChild?.childCount).toBe(4);
    runUserCommand(session, "add-column-before");
    expect(table()?.firstChild?.childCount).toBe(5);
    runUserCommand(session, "delete-column");
    expect(table()?.firstChild?.childCount).toBe(4);

    const cellAtSelection = () => {
      const { $from } = session.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name === "table_cell" || node.type.name === "table_header") {
          return { node, position: $from.before(depth) };
        }
      }
      return null;
    };
    const selectedCell = cellAtSelection();
    expect(selectedCell?.node.type.name).toBe("table_cell");
    runUserCommand(session, "toggle-header-cell");
    expect(session.state.doc.nodeAt(selectedCell?.position ?? -1)?.type.name).toBe("table_cell");

    runUserCommand(session, "delete-table");
    expect(session.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(session.session.draftSource).not.toContain("|");
  });

  it("keeps all cells intact when an unpersistable merge or split is requested", () => {
    const { session } = tableSession();
    const headerPositions: number[] = [];
    session.state.doc.descendants((node, position) => {
      if (node.type.name === "table_header") headerPositions.push(position);
      return node.type.name === "table" || node.type.name === "table_row";
    });
    const anchor = headerPositions[0];
    const head = headerPositions[1];
    expect(anchor).toBeDefined();
    expect(head).toBeDefined();
    if (anchor === undefined || head === undefined) return;

    session.applyTransaction(
      session.state.tr.setSelection(CellSelection.create(session.state.doc, anchor, head)),
      "user",
    );
    runUserCommand(session, "merge-cells");
    const headerRow = () => session.state.doc.firstChild?.firstChild;
    expect(headerRow()?.childCount).toBe(3);
    expect(headerRow()?.firstChild?.attrs.colspan).toBe(1);

    runUserCommand(session, "split-cell");
    expect(headerRow()?.childCount).toBe(3);
    expect(headerRow()?.firstChild?.attrs.colspan).toBe(1);
  });

  it("undoes and redoes the last edit", () => {
    const session = freshSession("Some text.\n");
    select(session, 1, 5);
    runUserCommand(session, "bold");
    expect(session.session.draftSource).toBe("**Some** text.\n");

    runUserCommand(session, "undo");
    expect(session.session.draftSource).toBe("Some text.\n");
    runUserCommand(session, "redo");
    expect(session.session.draftSource).toBe("**Some** text.\n");
  });

  it("sets quote style idempotently and leaves it through Paragraph", () => {
    const session = freshSession("Quoted words.\n");
    select(session, 1);
    runUserCommand(session, "blockquote");
    expect(session.session.draftSource).toBe("> Quoted words.\n");

    runUserCommand(session, "blockquote");
    expect(session.session.draftSource).toBe("> Quoted words.\n");

    runUserCommand(session, "paragraph");
    expect(session.session.draftSource).toBe("Quoted words.\n");
  });

  it("replaces quote style with a heading as one undoable change", () => {
    const session = freshSession("> Quoted words.\n");
    select(session, 2);

    runUserCommand(session, "heading-2");
    expect(session.session.draftSource).toBe("## Quoted words.\n");

    runUserCommand(session, "undo");
    expect(session.session.draftSource).toBe("> Quoted words.\n");
  });

  it("applies a selected style to every text block touched by the selection", () => {
    const session = freshSession("First block.\n\nSecond block.\n");
    select(session, 3, session.state.doc.content.size - 2);

    runUserCommand(session, "heading-3");
    expect(session.session.draftSource).toBe("### First block.\n\n### Second block.\n");
  });

  it("turns every selected row in one quote back into paragraphs", () => {
    const session = freshSession("> First block.\n>\n> Second block.\n");
    select(session, 2, session.state.doc.content.size - 2);

    runUserCommand(session, "paragraph");
    expect(session.session.draftSource).toBe("First block.\n\nSecond block.\n");
  });

  it("turns an empty current block into the selected style and keeps typing there", () => {
    const session = freshSession();
    select(session, 1);

    runUserCommand(session, "heading-2");
    expect(session.state.selection.$from.parent.type.name).toBe("heading");
    expect(session.state.selection.$from.parent.attrs.level).toBe(2);

    session.applyTransaction(session.state.tr.insertText("Ready to write"), "user");
    expect(session.session.draftSource).toBe("## Ready to write");
  });
});
