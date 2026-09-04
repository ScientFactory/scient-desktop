import type { Node as ProseMirrorNode } from "prosemirror-model";
import { describe, expect, it } from "vite-plus/test";
import { ScientProseMirrorSession } from "./session";
import { scientMarkdownSchema } from "./schema";
import { TextSelection } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { runScientMarkdownCommand, type ScientMarkdownCommand } from "./commands";

function semantics(node: ProseMirrorNode): unknown {
  return {
    type: node.type.name,
    text: node.text,
    attrs: Object.fromEntries(
      Object.entries(node.attrs).filter(([key]) => !["sourceId", "sourceCopyId"].includes(key)),
    ),
    marks: node.marks.map((mark) => mark.toJSON()),
    children: Array.from({ length: node.childCount }, (_, i) => semantics(node.child(i))),
  };
}

function expectRoundTrip(session: ScientProseMirrorSession) {
  const reopened = new ScientProseMirrorSession({
    source: session.session.draftSource,
    revision: "reopened",
  });
  expect(semantics(reopened.state.doc)).toEqual(semantics(session.state.doc));
}

describe("Markdown edit/save/reopen semantics", () => {
  it("round-trips a hard break in a cell without enabling arbitrary HTML", () => {
    const session = new ScientProseMirrorSession({
      source: "| A | B |\n| --- | --- |\n| left | right |\n",
      revision: "r0",
    });
    let pos = 0;
    session.state.doc.descendants((node, position) => {
      if (node.text === "left") pos = position;
    });
    session.applyTransaction(
      session.state.tr.insert(pos + 2, scientMarkdownSchema.nodes.hard_break!.create()),
      "user",
    );
    expectRoundTrip(session);
    expect(session.session.draftSource).toContain("le<br>ft");
  });

  it.each([
    "add-row-before",
    "add-row-after",
    "add-column-before",
    "add-column-after",
    "delete-row",
    "delete-column",
  ] satisfies ScientMarkdownCommand[])("keeps the table representable after %s", (command) => {
    const session = new ScientProseMirrorSession({
      source: "| A | B |\n| :--- | ---: |\n| left | right |\n",
      revision: "r0",
    });
    session.applyTransaction(
      session.state.tr.setSelection(TextSelection.create(session.state.doc, 3)),
      "user",
    );
    runScientMarkdownCommand(command, session.state, (tr) => session.applyTransaction(tr, "user"));
    expectRoundTrip(session);
  });

  it.each(["merge-cells", "split-cell", "toggle-header-cell"] satisfies ScientMarkdownCommand[])(
    "does not offer unpersistable %s",
    (command) => {
      const session = new ScientProseMirrorSession({
        source: "| A | B |\n| --- | --- |\n| left | right |\n",
        revision: "r0",
      });
      const before = session.session.draftSource;
      expect(
        runScientMarkdownCommand(command, session.state, (tr) =>
          session.applyTransaction(tr, "user"),
        ),
      ).toBe(false);
      expect(session.session.draftSource).toBe(before);
    },
  );
  it.each([0, 1, 2, 3])("edits the actual cell when text repeats: cell %i", (cell) => {
    const session = new ScientProseMirrorSession({
      source: "| a | a |\n| --- | --- |\n| a | a |\n",
      revision: "r0",
    });
    const positions: number[] = [];
    session.state.doc.descendants((node, pos) => {
      if (node.isText) positions.push(pos);
    });
    session.applyTransaction(session.state.tr.insertText("a", positions[cell]!), "user");
    expectRoundTrip(session);
  });

  it.each([
    "x|",
    "*a*",
    "[x]",
    "[0,1]",
    "[^1]",
    "[x](file.md)",
    "[x][ref]",
    "\\|",
    "<br>",
    "😀",
    "`x`",
    "&#124;",
    "  ",
  ])("keeps inserted text literal: %s", (text) => {
    const session = new ScientProseMirrorSession({
      source: "| A | B |\n| --- | --- |\n| left | right |\n",
      revision: "r0",
    });
    let pos = 0;
    session.state.doc.descendants((node, position) => {
      if (node.text === "left") pos = position;
    });
    session.applyTransaction(session.state.tr.insertText(text, pos), "user");
    expectRoundTrip(session);
  });

  it("keeps trailing cell spaces after serialization", () => {
    const session = new ScientProseMirrorSession({
      source: "| A | B |\n| --- | --- |\n| left | right |\n",
      revision: "r0",
    });
    let pos = 0;
    session.state.doc.descendants((node, position) => {
      if (node.text === "left") pos = position + node.nodeSize;
    });
    session.applyTransaction(session.state.tr.insertText("  ", pos), "user");
    expectRoundTrip(session);
  });

  it("rejects pasted spans without removing any existing table content", () => {
    const session = new ScientProseMirrorSession({
      source: "| A | B |\n| --- | --- |\n| left | right |\n",
      revision: "r0",
    });
    const before = session.state.doc;
    session.applyTransaction(
      session.state.tr.setNodeMarkup(2, undefined, { ...before.nodeAt(2)!.attrs, colspan: 2 }),
      "user",
    );
    expect(session.state.doc).toBe(before);
    expect(session.createSaveIntent()).toBeNull();
  });

  it("preserves source and semantics through repeated save/edit/reopen cycles", () => {
    const source =
      "# Keep  __style__\r\n\r\n+ parent\r\n  * nested __word__\r\n\r\n| a | a |\r\n| :--- | ---: |\r\n| a | a |\r\n";
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    for (let index = 0; index < 30; index += 1) {
      const positions: number[] = [];
      session.state.doc.descendants((node, pos) => {
        if (node.isText && !node.marks.length && node.text?.includes("a")) positions.push(pos);
      });
      const pos = positions[index % positions.length]!;
      const text = ["😀", "*literal*", "ת", "[]", "\\", "&amp;"][index % 6]!;
      session.applyTransaction(session.state.tr.insertText(text, pos), "user");
      expectRoundTrip(session);
      expect(session.session.draftSource.startsWith("# Keep  __style__\r\n\r\n")).toBe(true);
      session.confirmSave(session.createSaveIntent()!, `r${index + 1}`);
    }
  });

  it("preserves unrelated bytes after inserting a block, saving, and editing again", () => {
    const session = new ScientProseMirrorSession({
      source: "- one\n\nZ  __two__\n",
      revision: "r0",
    });
    session.applyTransaction(
      session.state.tr.insert(
        0,
        scientMarkdownSchema.nodes.paragraph!.create(null, scientMarkdownSchema.text("Added")),
      ),
      "user",
    );
    const intent = session.createSaveIntent()!;
    session.confirmSave(intent, "r1");
    session.applyTransaction(session.state.tr.insertText("!", 6), "user");
    expect(session.session.draftSource).toBe("Added!\n\n- one\n\nZ  __two__\n");
    expectRoundTrip(session);
  });

  it.each(["[Methods][m]", "[m][]", "[m]"])(
    "retains document reference context: %s",
    (reference) => {
      const session = new ScientProseMirrorSession({
        source: `See ${reference}.\n\n[m]: other.md\n`,
        revision: "r0",
      });
      let linked = false;
      session.state.doc.descendants((node) => {
        if (node.marks.some((mark) => mark.type.name === "link")) linked = true;
      });
      expect(linked).toBe(true);
      session.applyTransaction(
        session.state.tr.addMark(1, 4, scientMarkdownSchema.marks.strong!.create()),
        "user",
      );
      expectRoundTrip(session);
    },
  );

  it("resolves definitions appearing later inside a blockquote", () => {
    const session = new ScientProseMirrorSession({
      source: "See [Methods][m].\n\n> [m]: other.md\n",
      revision: "r0",
    });
    let href: unknown;
    session.state.doc.firstChild!.descendants((node) => {
      href ??= node.marks.find((mark) => mark.type.name === "link")?.attrs.href;
    });
    expect(href).toBe("other.md");
    session.applyTransaction(session.state.tr.insertText("Here: ", 1), "user");
    expectRoundTrip(session);
  });

  it("refreshes reference links when their source definition changes and when it is undone", () => {
    const source = "See [Methods][m].\n\n[m]: old.md\n";
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    const definitionPos = session.state.doc.firstChild!.nodeSize;
    session.applyTransaction(
      session.state.tr.setNodeMarkup(definitionPos, undefined, {
        ...session.state.doc.nodeAt(definitionPos)!.attrs,
        source: "[m]: new.md",
      }),
      "user",
    );
    expect(session.session.draftSource).toBe(source.replace("old.md", "new.md"));
    expectRoundTrip(session);
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source);
    expectRoundTrip(session);
  });

  it("keeps reference removal and restoration coherent without resetting the selection", () => {
    const source = "See [Methods][m].\n\n[m]: old.md\n";
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    const position = session.state.doc.firstChild!.nodeSize;
    const beforeSelection = session.state.selection;
    session.applyTransaction(
      session.state.tr.delete(position, session.state.doc.content.size),
      "user",
    );
    expect(session.state.selection.eq(beforeSelection)).toBe(true);
    expect(session.state.doc.textContent).toContain("[Methods][m]");
    expectRoundTrip(session);
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source);
    expectRoundTrip(session);
    runScientMarkdownCommand("redo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expectRoundTrip(session);
  });

  it("refreshes reference-style images while preserving their source spelling", () => {
    const source = '![Plot][figure]\n\n[figure]: old.png "Caption"\n';
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    const position = session.state.doc.firstChild!.nodeSize;
    session.applyTransaction(
      session.state.tr.setNodeMarkup(position, undefined, {
        ...session.state.doc.nodeAt(position)!.attrs,
        source: '[figure]: new.png "New caption"',
      }),
      "user",
    );
    expect(session.session.draftSource).toContain("![Plot][figure]");
    expect(session.state.doc.firstChild!.firstChild!.attrs.src).toBe("new.png");
    expectRoundTrip(session);
  });

  it("uses the refreshed destination when the consumer is formatted after editing its definition", () => {
    const session = new ScientProseMirrorSession({
      source: "See [Methods][m].\n\n[m]: old.md\n",
      revision: "r0",
    });
    session.applyTransaction(session.state.tr.insertText("Also: ", 1), "user");
    const position = session.state.doc.firstChild!.nodeSize;
    session.applyTransaction(
      session.state.tr.setNodeMarkup(position, undefined, {
        ...session.state.doc.nodeAt(position)!.attrs,
        source: "[m]: new.md",
      }),
      "user",
    );
    expectRoundTrip(session);
    session.applyTransaction(
      session.state.tr.addMark(1, 4, scientMarkdownSchema.marks.strong!.create()),
      "user",
    );
    expect(session.session.draftSource).not.toContain("old.md");
    expectRoundTrip(session);
  });

  it("retains caret position and earlier text undo when a reference href changes", () => {
    const source = "See [Methods][m].\n\n[m]: old.md\n";
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    session.applyTransaction(session.state.tr.insertText("X", 6), "user");
    session.applyTransaction(
      closeHistory(session.state.tr).setSelection(TextSelection.create(session.state.doc, 7)),
      "user",
    );
    const beforeSelection = session.state.selection;
    const position = session.state.doc.firstChild!.nodeSize;
    session.applyTransaction(
      session.state.tr.setNodeMarkup(position, undefined, {
        ...session.state.doc.nodeAt(position)!.attrs,
        source: "[m]: new.md",
      }),
      "user",
    );
    expect(session.state.selection.eq(beforeSelection)).toBe(true);
    expectRoundTrip(session);
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expectRoundTrip(session);
    runScientMarkdownCommand("undo", session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source);
    expectRoundTrip(session);
  });

  it.each([
    "`a\\|b`",
    "[[file\\|label]]",
    "$a\\|b$",
    "\\(a\\|b\\)",
    "\\[a\\|b\\]",
    "[file](a%7Cb.md)",
  ])("keeps inline syntax in a serialized table: %s", (inline) => {
    const session = new ScientProseMirrorSession({
      source: `| A | B |\n| --- | --- |\n| lead ${inline} | right |\n`,
      revision: "r0",
    });
    let pos = 0;
    session.state.doc.descendants((node, position) => {
      if (node.text?.startsWith("lead ")) pos = position;
    });
    session.applyTransaction(
      session.state.tr.addMark(pos, pos + 4, scientMarkdownSchema.marks.strong!.create()),
      "user",
    );
    expectRoundTrip(session);
  });
});
