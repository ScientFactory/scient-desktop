import { reconcileMarkdown, type MarkdownExternalUpdate } from "@scientfactory/scient-markdown";
import { undo, redo, closeHistory } from "prosemirror-history";
import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";
import { ScientProseMirrorSession } from "./session";

describe("incremental rich external updates", () => {
  const source = "First paragraph.\n\nSecond paragraph.\n";
  const apply = (session: ScientProseMirrorSession, base: string, disk: string) => {
    const local = session.session.draftSource;
    const merged = reconcileMarkdown(base, local, disk);
    expect(merged).not.toBeNull();
    const update: MarkdownExternalUpdate = {
      ...merged!,
      previousSource: local,
      editVersion: session.session.editVersion + 1,
    };
    const commit = session.prepareExternalUpdate(update);
    expect(commit).not.toBeNull();
    commit!();
    return update;
  };
  it("keeps the local selection and undo/redo while an agent appends", () => {
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    session.applyTransaction(session.state.tr.insertText("My ", 1), "user");
    const selection = session.state.selection.toJSON();
    apply(session, source, source + "\n## Agent appendix\n");
    expect(session.state.selection.toJSON()).toEqual(selection);
    undo(session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(source + "\n## Agent appendix\n");
    redo(session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe("My " + source + "\n## Agent appendix\n");
  });
  it("maps undo across an insertion before the local paragraph", () => {
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    session.applyTransaction(session.state.tr.insertText("Mine ", 1), "user");
    apply(session, source, "# External heading\n\n" + source);
    undo(session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe("# External heading\n\n" + source);
  });
  it("preserves a separate local redo branch across an external update", () => {
    const session = new ScientProseMirrorSession({ source, revision: "r0" });
    session.applyTransaction(session.state.tr.insertText("A ", 1), "user");
    session.applyTransaction(closeHistory(session.state.tr).insertText("B ", 1), "user");
    undo(session.state, (tr) => session.applyTransaction(tr, "user"));
    apply(session, source, source + "\nAgent\n");
    redo(session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe("B A " + source + "\nAgent\n");
  });
  it.each([1, 2])("preserves figure-boundary typing and undo across a merge at %i", (position) => {
    const base = '![Plot](plot.png "Caption")\n\nIndependent paragraph.\n';
    const session = new ScientProseMirrorSession({ source: base, revision: "r0" });
    session.applyTransaction(
      session.state.tr.setSelection(TextSelection.create(session.state.doc, position)),
      "user",
    );
    session.applyTransaction(session.state.tr.insertText("Local text"), "user");
    const local = session.session.draftSource;
    expect(session.state.doc.childCount).toBe(3);
    const selection = session.state.selection.toJSON();
    const disk = base.replace("Independent paragraph.", "Agent paragraph.");
    apply(session, base, disk);
    expect(session.state.selection.toJSON()).toEqual(selection);
    expect(session.session.draftSource).toBe(
      local.replace("Independent paragraph.", "Agent paragraph."),
    );
    undo(session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(disk);
    redo(session.state, (tr) => session.applyTransaction(tr, "user"));
    expect(session.session.draftSource).toBe(
      local.replace("Independent paragraph.", "Agent paragraph."),
    );
  });
  it.each(["LOCAL ", "*unfinished", "  ", "[unfinished", "\\"])(
    "preserves in-progress typing %j alongside tasks and inline math",
    (typed) => {
      const base =
        "# Concurrent editing QA\n\nLocal paragraph for typing here.\n\nIndependent paragraph for the other writer.\n\n- [ ] First synthetic task\n- [ ] Second synthetic task\n\nInline math $a^2 + b^2 = c^2$ stays unchanged.\n\n## Appendix anchor\n\nKeep this paragraph unchanged.\n";
      const session = new ScientProseMirrorSession({ source: base, revision: "r0" });
      const position =
        session.state.doc.child(0).nodeSize + session.state.doc.child(1).nodeSize - 1;
      session.applyTransaction(session.state.tr.insertText(typed, position), "user");
      const disk = base.replace(
        "Independent paragraph for the other writer.",
        "Independent paragraph UPDATED BY THE OTHER WRITER.",
      );
      apply(session, base, disk);
      expect(session.session.draftSource).toBe(disk.replace("here.", "here." + typed));
      undo(session.state, (tr) => session.applyTransaction(tr, "user"));
      expect(session.session.draftSource).toBe(disk);
    },
  );
});
