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

  it.each([
    ["ltr", "ltr", "ArrowLeft", "start", "before"],
    ["ltr", "ltr", "ArrowRight", "end", "after"],
    ["rtl", "ltr", "ArrowLeft", "end", "before"],
    ["rtl", "ltr", "ArrowRight", "start", "after"],
    ["ltr", "rtl", "ArrowLeft", "start", "after"],
    ["ltr", "rtl", "ArrowRight", "end", "before"],
    ["rtl", "rtl", "ArrowLeft", "end", "after"],
    ["rtl", "rtl", "ArrowRight", "start", "before"],
  ] as const)(
    "moves a %s field in %s prose through its physical %s boundary",
    (fieldDirection, surroundingDirection, key, boundary, expectedSide) => {
      const markdownDocument = createScientMarkdownProjection("Before [@source] after.\n").document;
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
      editor.value = fieldDirection === "rtl" ? "@מקור" : "@source";
      const caret = boundary === "start" ? 0 : editor.value.length;
      editor.setSelectionRange(caret, caret);
      const event = new KeyboardEvent("keydown", { key, cancelable: true });

      expect(
        handleInlineAtomEditorKeyDown({
          editor,
          event,
          fieldDirection,
          getPos: () => position,
          node: atom,
          surroundingDirection,
          view,
        }),
      ).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(state.selection.head).toBe(
        expectedSide === "before" ? position : position + atom.nodeSize,
      );
    },
  );

  it.each([
    ["Shift+ArrowLeft", { key: "ArrowLeft", shiftKey: true }],
    ["Alt+ArrowRight", { altKey: true, key: "ArrowRight" }],
    ["Meta+Enter", { key: "Enter", metaKey: true }],
    ["Control+Backspace", { ctrlKey: true, key: "Backspace" }],
  ] as const)("leaves %s to the nested field", (_label, eventInit) => {
    const markdownDocument = createScientMarkdownProjection("Before [@source] after.\n").document;
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
    editor.value = eventInit.key === "Backspace" ? "" : "@source";
    const caret = eventInit.key === "ArrowRight" ? editor.value.length : 0;
    editor.setSelectionRange(caret, caret);
    const event = new KeyboardEvent("keydown", { ...eventInit, cancelable: true });

    expect(
      handleInlineAtomEditorKeyDown({
        editor,
        event,
        fieldDirection: "ltr",
        getPos: () => position,
        node: atom,
        surroundingDirection: "ltr",
        view,
      }),
    ).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(state.selection).toBeInstanceOf(NodeSelection);
    expect(state.selection.from).toBe(position);
  });
});
