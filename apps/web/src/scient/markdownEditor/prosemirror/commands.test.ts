import { describe, expect, it } from "vite-plus/test";
import type { Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";

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
