// @vitest-environment happy-dom
import { GapCursor } from "prosemirror-gapcursor";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it, vi } from "vite-plus/test";

import { createScientMarkdownProjection } from "./projection";
import {
  handleInlineAtomEditorKeyDown,
  leaveAtomEditor,
  selectionBesideNode,
  selectionOutsideNode,
} from "./safeSelection";

describe("safe atom selections", () => {
  it("prefers the following writable text block", () => {
    const document = createScientMarkdownProjection("$$\nx^2\n$$\n\nAfter.\n").document;
    const atom = document.firstChild!;
    const selection = selectionOutsideNode(document, 0, atom.nodeSize);

    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection?.$head.parent.textContent).toBe("After.");
  });

  it("uses a non-mutating gap when the atom is the whole document", () => {
    const document = createScientMarkdownProjection("$$\nx^2\n$$\n").document;
    const atom = document.firstChild!;
    const selection = selectionOutsideNode(document, 0, atom.nodeSize);

    expect(selection).toBeInstanceOf(GapCursor);
    expect(selection?.head).toBe(document.content.size);
    expect(
      (
        GapCursor as unknown as {
          valid(position: NonNullable<typeof selection>["$head"]): boolean;
        }
      ).valid(selection!.$head),
    ).toBe(true);
  });

  it("moves a nested editor out of its node selection before returning focus", () => {
    const document = createScientMarkdownProjection("$$\nx^2\n$$\n\nAfter.\n").document;
    const atom = document.firstChild!;
    let state = EditorState.create({ doc: document });
    const focus = vi.fn();
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
      focus,
    } as Pick<EditorView, "dispatch" | "focus" | "state"> as EditorView;

    expect(leaveAtomEditor(view, () => 0, atom)).toBe(true);
    expect(state.selection).toBeInstanceOf(TextSelection);
    expect(state.selection.$head.parent.textContent).toBe("After.");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("finds the requested side of an inline atom", () => {
    const markdownDocument = createScientMarkdownProjection("Before [@source] after.\n").document;
    let position = -1;
    let atom = markdownDocument;
    markdownDocument.descendants((node, nodePosition) => {
      if (node.type.name !== "citation") return;
      position = nodePosition;
      atom = node;
    });

    const before = selectionBesideNode(markdownDocument, position, atom.nodeSize, "before");
    const after = selectionBesideNode(markdownDocument, position, atom.nodeSize, "after");

    expect(before).toBeInstanceOf(TextSelection);
    expect(before?.head).toBe(position);
    expect(after).toBeInstanceOf(TextSelection);
    expect(after?.head).toBe(position + atom.nodeSize);
  });

  it("mirrors physical arrow exits for RTL inline fields", () => {
    const markdownDocument = createScientMarkdownProjection("Before [@מקור] after.\n").document;
    let position = -1;
    let atom = markdownDocument;
    markdownDocument.descendants((node, nodePosition) => {
      if (node.type.name !== "citation") return;
      position = nodePosition;
      atom = node;
    });
    let state = EditorState.create({
      doc: markdownDocument,
      selection: NodeSelection.create(markdownDocument, position),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
      focus: vi.fn(),
    } as Pick<EditorView, "dispatch" | "focus" | "state"> as EditorView;
    const editor = globalThis.document.createElement("input");
    editor.value = "@מקור";
    editor.setSelectionRange(editor.value.length, editor.value.length);
    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true });

    expect(
      handleInlineAtomEditorKeyDown({
        direction: "rtl",
        editor,
        event: left,
        getPos: () => position,
        node: atom,
        view,
      }),
    ).toBe(true);
    expect(left.defaultPrevented).toBe(true);
    expect(state.selection.head).toBe(position + atom.nodeSize);

    state = state.apply(
      state.tr
        .setSelection(NodeSelection.create(state.doc, position))
        .setMeta("addToHistory", false),
    );
    editor.setSelectionRange(0, 0);
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    expect(
      handleInlineAtomEditorKeyDown({
        direction: "rtl",
        editor,
        event: right,
        getPos: () => position,
        node: atom,
        view,
      }),
    ).toBe(true);
    expect(right.defaultPrevented).toBe(true);
    expect(state.selection.head).toBe(position);
  });
});
