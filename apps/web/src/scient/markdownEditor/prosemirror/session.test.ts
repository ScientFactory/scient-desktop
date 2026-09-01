import { beginMarkdownSave, type MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { splitBlock } from "prosemirror-commands";
import { GapCursor } from "prosemirror-gapcursor";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScientProseMirrorSession } from "./session";

describe("ScientProseMirrorSession", () => {
  it("starts in the first writable block instead of selecting leading front matter", () => {
    const source = "---\ntitle: Safe\n---\n\n# Heading\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:before" });

    expect(session.state.selection).toBeInstanceOf(TextSelection);
    expect(session.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(session.state.selection.$from.parent.type.name).toBe("heading");
    session.applyTransaction(
      session.state.tr.insertText("Updated ", session.state.selection.from),
      "user",
    );
    expect(session.session.draftSource).toBe("---\ntitle: Safe\n---\n\n# Updated Heading\n");
  });

  it("uses a non-destructive gap when a source island is the whole document", () => {
    const source = "---\ntitle: Safe\n---\n";
    const session = new ScientProseMirrorSession({ source, revision: "sha256:before" });

    expect(session.state.selection).toBeInstanceOf(GapCursor);
    expect(session.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(session.state.selection.head).toBe(session.state.doc.content.size);
    expect(session.session.draftSource).toBe(source);
  });

  it("projects a restored draft while retaining the authoritative CAS baseline", () => {
    const session = new ScientProseMirrorSession({
      source: "Local draft\n",
      authoritativeSource: "Disk\n",
      revision: "sha256:disk",
    });

    expect(session.state.doc.textContent).toBe("Local draft");
    expect(session.createSaveIntent()).toEqual({
      source: "Local draft\n",
      expectedRevision: "sha256:disk",
      editVersion: 1,
    });
  });

  it("does not parse, serialize, transact, or request a save during 100 editability cycles", () => {
    const onUserSourceChange = vi.fn();
    const session = new ScientProseMirrorSession({
      source: "- item\n  - nested\n",
      revision: "sha256:before",
      onUserSourceChange,
    });
    const initialEditorState = session.state;
    const initialDocument = session.state.doc;

    for (let index = 0; index < 100; index += 1) {
      session.setMode("write");
      session.setMode("read");
    }

    expect(session.state).toBe(initialEditorState);
    expect(session.state.doc).toBe(initialDocument);
    expect(session.session.editVersion).toBe(0);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("ignores non-user document transactions for save intent", () => {
    const onUserSourceChange = vi.fn();
    const session = new ScientProseMirrorSession({
      source: "Paragraph\n",
      revision: "sha256:before",
      onUserSourceChange,
    });
    session.applyTransaction(session.state.tr.insertText("system ", 1, 1), "system");

    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(session.session.editVersion).toBe(0);
  });

  it("emits a revision-bound intent for a user-authored transaction", () => {
    const onUserSourceChange = vi.fn();
    const session = new ScientProseMirrorSession({
      source: "Paragraph\n",
      revision: "sha256:before",
      onUserSourceChange,
    });
    session.applyTransaction(session.state.tr.insertText("Edited ", 1, 1), "user");

    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(onUserSourceChange).toHaveBeenCalledWith("Edited Paragraph\n", {
      source: "Edited Paragraph\n",
      expectedRevision: "sha256:before",
      editVersion: 1,
    });
  });

  it("adopts a clean external update without emitting user save intent", () => {
    const onUserSourceChange = vi.fn();
    const session = new ScientProseMirrorSession({
      source: "Before\n",
      revision: "sha256:before",
      onUserSourceChange,
    });

    expect(session.receiveExternalSource({ source: "After\n", revision: "sha256:after" })).toBe(
      "adopted",
    );
    expect(session.state.doc.textContent).toBe("After");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("retains a dirty local document when an external agent edit conflicts", () => {
    const session = new ScientProseMirrorSession({
      source: "Before\n",
      revision: "sha256:before",
    });
    session.applyTransaction(session.state.tr.insertText("Local ", 1, 1), "user");

    expect(session.receiveExternalSource({ source: "Agent\n", revision: "sha256:agent" })).toBe(
      "conflict",
    );
    expect(session.state.doc.textContent).toBe("Local Before");
    expect(session.session.conflict).toEqual({
      externalSource: "Agent\n",
      externalRevision: "sha256:agent",
    });
  });

  it("resolves an external conflict explicitly with disk or local source", () => {
    const disk = new ScientProseMirrorSession({ source: "Before\n", revision: "r0" });
    disk.applyTransaction(disk.state.tr.insertText("Local ", 1, 1), "user");
    disk.receiveExternalSource({ source: "Agent\n", revision: "r-agent" });
    disk.resolveExternalConflict("disk");
    expect(disk.state.doc.textContent).toBe("Agent");
    expect(disk.session.draftSource).toBe("Agent\n");
    expect(disk.session.baselineRevision).toBe("r-agent");

    const local = new ScientProseMirrorSession({ source: "Before\n", revision: "r0" });
    local.applyTransaction(local.state.tr.insertText("Local ", 1, 1), "user");
    local.receiveExternalSource({ source: "Agent\n", revision: "r-agent" });
    local.resolveExternalConflict("local");
    expect(local.state.doc.textContent).toBe("Local Before");
    expect(local.session.draftSource).toBe("Local Before\n");
    expect(local.session.baselineRevision).toBe("r-agent");
  });

  it("assigns distinct source identities when a user splits one source block", () => {
    const session = new ScientProseMirrorSession({
      source: "Beforeafter\n",
      revision: "sha256:before",
    });
    const selected = session.state.apply(
      session.state.tr.setSelection(TextSelection.create(session.state.doc, "Before".length + 1)),
    );
    let splitTransaction = selected.tr;
    expect(
      splitBlock(selected, (transaction) => {
        splitTransaction = transaction;
      }),
    ).toBe(true);
    session.applyTransaction(splitTransaction, "user");

    const identities: string[] = [];
    session.state.doc.forEach((node) => identities.push(String(node.attrs.sourceId)));
    expect(new Set(identities).size).toBe(2);
    expect(identities[0]).toMatch(/^source-/u);
    expect(identities[1]).toMatch(/^local-/u);
    expect(session.session.draftSource).toBe("Before\n\nafter\n");
  });

  it("projects an explicit source-mode edit and confirms it without another user callback", () => {
    const onUserSourceChange = vi.fn();
    const session = new ScientProseMirrorSession({
      source: "Before\n",
      revision: "r0",
      onUserSourceChange,
    });
    session.replaceUserSource("# After\n");
    const intent = onUserSourceChange.mock.calls[0]?.[1];
    expect(intent).toEqual({ source: "# After\n", expectedRevision: "r0", editVersion: 1 });
    expect(session.state.doc.firstChild?.type.name).toBe("heading");

    session.confirmSave(intent!, "r1");
    expect(session.session.baselineSource).toBe("# After\n");
    expect(session.session.baselineRevision).toBe("r1");
    expect(session.session.draftSource).toBe("# After\n");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("rebases newer typing after an older save confirmation", () => {
    const intents: MarkdownSaveIntent[] = [];
    const session = new ScientProseMirrorSession({
      source: "zero\n",
      revision: "r0",
      onUserSourceChange: (_source, nextIntent) => {
        if (nextIntent) intents.push(nextIntent);
      },
    });
    session.applyTransaction(session.state.tr.insertText("one ", 1, 1), "user");
    session.applyTransaction(session.state.tr.insertText("two ", 1, 1), "user");
    session.confirmSave(intents[0]!, "r1");

    expect(beginMarkdownSave(session.session)).toEqual({
      source: "two one zero\n",
      expectedRevision: "r1",
      editVersion: 2,
    });
  });

  it("maps rich blocks to their current source ranges after preceding edits", () => {
    const session = new ScientProseMirrorSession({
      source: "# First\n\n## Second\n",
      revision: "r0",
      mode: "write",
    });
    session.applyTransaction(session.state.tr.insertText("Expanded ", 1, 1), "user");
    let secondHeadingPosition = -1;
    session.state.doc.descendants((node, position) => {
      if (node.type.name === "heading" && node.textContent === "Second") {
        secondHeadingPosition = position;
        return false;
      }
      return true;
    });

    const expectedSourceOffset = session.session.draftSource.indexOf("## Second");
    expect(session.sourceOffsetForDocumentPosition(secondHeadingPosition + 1)).toBe(
      expectedSourceOffset,
    );
    const mappedDocumentPosition = session.documentPositionForSourceOffset(
      expectedSourceOffset + 3,
    );
    expect(mappedDocumentPosition).toBe(secondHeadingPosition);
    expect(session.state.doc.nodeAt(mappedDocumentPosition!)?.textContent).toBe("Second");
  });

  it("keeps current block ranges when an older save is confirmed", () => {
    const intents: MarkdownSaveIntent[] = [];
    const session = new ScientProseMirrorSession({
      source: "First\n\nSecond\n",
      revision: "r0",
      mode: "write",
      onUserSourceChange: (_source, intent) => {
        if (intent) intents.push(intent);
      },
    });
    session.applyTransaction(session.state.tr.insertText("One ", 1, 1), "user");
    session.applyTransaction(session.state.tr.insertText("Two ", 1, 1), "user");
    session.confirmSave(intents[0]!, "r1");
    let secondParagraphPosition = -1;
    session.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.textContent === "Second") {
        secondParagraphPosition = position;
        return false;
      }
      return true;
    });

    expect(session.sourceOffsetForDocumentPosition(secondParagraphPosition + 1)).toBe(
      session.session.draftSource.indexOf("Second"),
    );
  });
});
