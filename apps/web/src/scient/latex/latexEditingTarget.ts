import type { Editor } from "@tiptap/core";
import { createContext, useCallback, useSyncExternalStore } from "react";

export const LatexInlineOwnerContext = createContext<Editor | null>(null);

// The document owns history/source; an inline field owns its local caret.
const targets = new WeakMap<Editor, Editor>();
const listeners = new WeakMap<Editor, Set<() => void>>();
export function activateLatexEditingTarget(owner: Editor, field: Editor): void {
  if (targets.get(owner) === field) return;
  targets.set(owner, field);
  listeners.get(owner)?.forEach((listener) => listener());
}
export function clearLatexEditingTarget(owner: Editor, field?: Editor): void {
  if ((!field || targets.get(owner) === field) && targets.delete(owner))
    listeners.get(owner)?.forEach((listener) => listener());
}
export function latexEditingTarget(owner: Editor): Editor {
  if (!owner.isDestroyed && document.activeElement === owner.view.dom) {
    targets.delete(owner);
    return owner;
  }
  const field = targets.get(owner);
  return field && !field.isDestroyed ? field : owner;
}

/** Menus and selection status subscribe to the same caret owner as commands. */
function useLatexEditingTarget(owner: Editor | null): Editor | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!owner) return () => {};
      const subscriptions = listeners.get(owner) ?? new Set<() => void>();
      listeners.set(owner, subscriptions);
      subscriptions.add(listener);
      const focus = () => clearLatexEditingTarget(owner);
      owner.on("focus", focus);
      return () => {
        subscriptions.delete(listener);
        owner.off("focus", focus);
      };
    },
    [owner],
  );
  const snapshot = useCallback(() => (owner ? latexEditingTarget(owner) : null), [owner]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Read the new target immediately, even before it emits its next transaction. */
export function useLatexEditingState(owner: Editor | null) {
  const editor = useLatexEditingTarget(owner);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!editor) return () => {};
      editor.on("transaction", listener);
      editor.on("update", listener);
      return () => {
        editor.off("transaction", listener);
        editor.off("update", listener);
      };
    },
    [editor],
  );
  const snapshot = useCallback(() => editor?.state ?? null, [editor]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { editor, state };
}
