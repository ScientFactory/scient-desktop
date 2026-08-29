import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Tail delay after pointer release during which reveals stay frozen (atomic-editor pattern). */
const REVEAL_FREEZE_TAIL_MS = 100;

const setPointerFreeze = StateEffect.define<boolean>();

/**
 * True while a pointer press, plus a short tail after release, should keep the
 * live-preview projection frozen so widgets do not dissolve under the cursor
 * mid-click and shift the text the user is aiming at.
 */
export const pointerFreezeField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPointerFreeze)) return effect.value;
    }
    return value;
  },
});

export const revealFreezeExtension = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    view.dispatch({ effects: setPointerFreeze.of(true) });
    const release = (): void => {
      window.removeEventListener("mouseup", release);
      window.setTimeout(() => {
        if (view.dom.isConnected) view.dispatch({ effects: setPointerFreeze.of(false) });
      }, REVEAL_FREEZE_TAIL_MS);
    };
    window.addEventListener("mouseup", release);
    return false;
  },
});

/** True when any selection range touches the [from, to) range. */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

/** Line numbers touched by any selection range. */
export function activeLineNumbers(state: EditorState): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) lines.add(number);
  }
  return lines;
}
