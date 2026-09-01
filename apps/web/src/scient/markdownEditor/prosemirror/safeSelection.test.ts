import { GapCursor } from "prosemirror-gapcursor";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it, vi } from "vite-plus/test";

import { createScientMarkdownProjection } from "./projection";
import { leaveAtomEditor, selectionOutsideNode } from "./safeSelection";

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
});
