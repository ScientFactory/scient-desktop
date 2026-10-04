import type { Node as ProseMirrorNode } from "prosemirror-model";
import { closeHistory, redo, undo } from "prosemirror-history";
import { describe, expect, it, vi } from "vite-plus/test";

import { runScientMarkdownCommand } from "./commands";
import { scientMarkdownSchema } from "./schema";
import { ScientProseMirrorSession } from "./session";

function author(source: string) {
  const onUserSourceChange = vi.fn();
  return {
    session: new ScientProseMirrorSession({ source, revision: "r0", onUserSourceChange }),
    onUserSourceChange,
  };
}

function positionOf(session: ScientProseMirrorSession, type: string): number {
  let position = -1;
  session.state.doc.descendants((node, offset) => {
    if (position < 0 && node.type.name === type) position = offset;
  });
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

function semantics(node: ProseMirrorNode): unknown {
  return {
    type: node.type.name,
    text: node.text,
    attrs: Object.fromEntries(
      Object.entries(node.attrs).filter(([key]) => !["sourceId", "sourceCopyId"].includes(key)),
    ),
    marks: node.marks.map((mark) => mark.toJSON()),
    children: Array.from({ length: node.childCount }, (_, index) => semantics(node.child(index))),
  };
}

function expectReopensFaithfully(session: ScientProseMirrorSession): void {
  const reopened = new ScientProseMirrorSession({
    source: session.session.draftSource,
    revision: "r1",
  });
  expect(semantics(reopened.state.doc)).toEqual(semantics(session.state.doc));
}

function editAttribute(
  session: ScientProseMirrorSession,
  type: string,
  name: string,
  value: string,
): void {
  session.applyTransaction(
    closeHistory(session.state.tr).setNodeAttribute(positionOf(session, type), name, value),
    "user",
  );
}

describe("Markdown write-back acceptance and retained input", () => {
  it.each([
    {
      source: "# Result $x^2$\n\nFollowing paragraph.\n",
      type: "inline_math",
      attribute: "tex",
      value: "x^2\n+y",
      correction: "x^2+y",
    },
    {
      source: "# Result [@smith]\n\nFollowing paragraph.\n",
      type: "citation",
      attribute: "source",
      value: "@smith\n@jones",
      correction: "@smith; @jones",
    },
    {
      source: "Result [@smith] end.\n",
      type: "citation",
      attribute: "source",
      value: "@smith] lost [",
      correction: "@smith; @jones",
    },
    {
      source: "<!-- old -->\n\nFollowing paragraph.\n",
      type: "raw_block",
      attribute: "source",
      value: "<!-- unfinished",
      correction: "<!-- completed -->",
    },
    {
      source: "Result \\(x^2\\) end.\n",
      type: "inline_math",
      attribute: "tex",
      value: "x\\) outside",
      correction: "x+1",
    },
    {
      source: "$$\nx^2\n$$\n\nFollowing paragraph.\n",
      type: "display_math",
      attribute: "tex",
      value: "x\n$$\nOutside",
      correction: "x+y",
    },
  ])(
    "retains unsafe $type input, then accepts its correction: $value",
    ({ source, type, attribute, value, correction }) => {
      const { session, onUserSourceChange } = author(source);
      const initialVersion = session.session.editVersion;
      editAttribute(session, type, attribute, value);

      expect(session.session.draftSource).toBe(source);
      expect(session.session.editVersion).toBe(initialVersion);
      expect(onUserSourceChange).not.toHaveBeenCalled();
      expect(session.pendingWriteback).not.toBeNull();
      expect(session.pendingWriteback?.document).toBe(session.state.doc);
      expect(session.pendingWriteback?.message.length).toBeGreaterThan(0);
      expect(session.state.doc.nodeAt(positionOf(session, type))?.attrs[attribute]).toBe(value);

      editAttribute(session, type, attribute, correction);
      expect(session.pendingWriteback).toBeNull();
      expect(onUserSourceChange).toHaveBeenCalledOnce();
      expectReopensFaithfully(session);
    },
  );

  it("retains an unrepresentable heading conversion and accepts returning to paragraph", () => {
    const source = "Result \\(x\n+y\\).\n\nFollowing paragraph.\n";
    const { session, onUserSourceChange } = author(source);
    session.applyTransaction(
      session.state.tr.setBlockType(
        0,
        session.state.doc.firstChild!.nodeSize,
        scientMarkdownSchema.nodes.heading!,
        { level: 2 },
      ),
      "user",
    );
    expect(session.state.doc.firstChild?.type.name).toBe("heading");
    expect(session.pendingWriteback).not.toBeNull();
    expect(session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    session.applyTransaction(
      session.state.tr.setBlockType(
        0,
        session.state.doc.firstChild!.nodeSize,
        scientMarkdownSchema.nodes.paragraph!,
      ),
      "user",
    );
    expect(session.pendingWriteback).toBeNull();
    expectReopensFaithfully(session);
  });

  it("Undo removes the refused change without publishing it; Redo retains it again", () => {
    const source = "Text [@smith] end.\n";
    const { session, onUserSourceChange } = author(source);
    editAttribute(session, "citation", "source", "@smith] lost [");
    expect(
      undo(session.state, (transaction) => session.applyTransaction(transaction, "user")),
    ).toBe(true);
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expectReopensFaithfully(session);
    expect(
      redo(session.state, (transaction) => session.applyTransaction(transaction, "user")),
    ).toBe(true);
    expect(session.pendingWriteback).not.toBeNull();
    expect(session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("holds subsequent prose with refused input and publishes both after correction", () => {
    const source = "Text [@smith] end.\n\nFollowing paragraph.\n";
    const { session, onUserSourceChange } = author(source);
    editAttribute(session, "citation", "source", "@smith] lost [");
    const lastParagraph = session.state.doc.firstChild!.nodeSize + 1;
    session.applyTransaction(session.state.tr.insertText("New ", lastParagraph), "user");
    expect(session.pendingWriteback).not.toBeNull();
    expect(session.state.doc.child(1).textContent).toBe("New Following paragraph.");
    expect(session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    editAttribute(session, "citation", "source", "@smith; @jones");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toContain("New Following paragraph.");
    expect(session.session.draftSource).toContain("[@smith; @jones]");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expectReopensFaithfully(session);
  });

  it.each(["bold", "italic", "strike", "code"] as const)(
    "requires ordinary %s formatting to succeed",
    (command) => {
      const { session, onUserSourceChange } = author(
        "Scientific 😀 result.\n\nUntouched $x^2$ paragraph.\n",
      );
      const mark =
        scientMarkdownSchema.marks[
          command === "bold" ? "strong" : command === "italic" ? "em" : command
        ]!;
      session.applyTransaction(session.state.tr.addMark(1, 11, mark.create()), "user");
      expect(session.pendingWriteback).toBeNull();
      expect(onUserSourceChange).toHaveBeenCalledOnce();
      expect(session.session.draftSource).toContain("Untouched $x^2$ paragraph.");
      expectReopensFaithfully(session);
    },
  );

  it.each(["heading-2", "bullet-list", "blockquote", "direction-rtl"] as const)(
    "requires ordinary %s conversion to succeed",
    (command) => {
      const { session, onUserSourceChange } = author("Scientific result.\n");
      expect(
        runScientMarkdownCommand(command, session.state, (transaction) =>
          session.applyTransaction(transaction, "user"),
        ),
      ).toBe(true);
      expect(session.pendingWriteback).toBeNull();
      expect(onUserSourceChange).toHaveBeenCalledOnce();
      expectReopensFaithfully(session);
    },
  );

  it("retains formatting that would split a Unicode character during UTF-8 publication", () => {
    const source = "Result 😀 end.\n";
    const { session, onUserSourceChange } = author(source);
    session.applyTransaction(
      session.state.tr.addMark(8, 9, scientMarkdownSchema.marks.strong!.create()),
      "user",
    );
    expect(session.session.draftSource).toBe(source);
    expect(session.pendingWriteback).not.toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(
      undo(session.state, (transaction) => session.applyTransaction(transaction, "user")),
    ).toBe(true);
    expect(session.pendingWriteback).toBeNull();
    expectReopensFaithfully(session);
  });

  it("accepts incomplete TeX inside a bounded inline equation", () => {
    const { session, onUserSourceChange } = author("Result \\(x^2\\) end.\n");
    editAttribute(session, "inline_math", "tex", "\\frac{");
    expect(session.pendingWriteback).toBeNull();
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expectReopensFaithfully(session);
  });

  it("requires a scientific table cell edit to succeed without replacing its neighbors", () => {
    const { session, onUserSourceChange } = author(
      "| A | B |\n| --- | --- |\n| left | right |\n\nUntouched paragraph.\n",
    );
    let position = -1;
    session.state.doc.descendants((node, offset) => {
      if (node.text === "left") position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    session.applyTransaction(session.state.tr.insertText("😀 ", position), "user");
    expect(session.pendingWriteback).toBeNull();
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(session.session.draftSource).toContain("Untouched paragraph.");
    expectReopensFaithfully(session);
  });

  it("allows an intentional reference definition change and refreshes dependent links", () => {
    const { session, onUserSourceChange } = author("[Methods][m]\n\n[m]: old.md\n");
    editAttribute(session, "raw_block", "source", "[m]: new.md");
    expect(session.pendingWriteback).toBeNull();
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(
      session.state.doc.firstChild?.firstChild?.marks.find((mark) => mark.type.name === "link")
        ?.attrs.href,
    ).toBe("new.md");
    expectReopensFaithfully(session);
  });

  it("keeps retained input when persistence acknowledges the same accepted source", () => {
    const source = "Text [@smith] end.\n";
    const { session, onUserSourceChange } = author(source);
    editAttribute(session, "citation", "source", "@smith] lost [");
    const retainedDocument = session.state.doc;
    const retained = session.pendingWriteback;
    session.synchronizePersistence({ ...session.session, baselineRevision: "r1" });
    expect(session.state.doc).toBe(retainedDocument);
    expect(session.pendingWriteback).toBe(retained);
    expect(session.session.baselineRevision).toBe("r1");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("reports an external update as conflict without replacing retained input", () => {
    const source = "Text [@smith] end.\n";
    const { session, onUserSourceChange } = author(source);
    editAttribute(session, "citation", "source", "@smith] lost [");
    const retainedDocument = session.state.doc;
    const retained = session.pendingWriteback;
    expect(
      session.receiveExternalSource({ source: "Agent changed this paragraph.\n", revision: "r1" }),
    ).toBe("deferred");
    expect(session.state.doc).toBe(retainedDocument);
    expect(session.pendingWriteback).toBe(retained);
    expect(session.state.doc.nodeAt(positionOf(session, "citation"))?.attrs.source).toBe(
      "@smith] lost [",
    );
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("clears retained input only after explicit discard adopts disk", () => {
    const { session, onUserSourceChange } = author("Text [@smith] end.\n");
    editAttribute(session, "citation", "source", "@smith] lost [");
    session.discardLocalChanges({ source: "Disk document.\n", revision: "r1" });
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe("Disk document.\n");
    expect(session.state.doc.textContent).toBe("Disk document.");
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expectReopensFaithfully(session);
  });

  it("keeps explicit Source editing available even for incomplete Markdown", () => {
    const { session, onUserSourceChange } = author("Text.\n");
    session.replaceUserSource("<!-- unfinished\n\nText.\n");
    expect(session.session.draftSource).toBe("<!-- unfinished\n\nText.\n");
    expect(session.pendingWriteback).toBeNull();
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });
});
