import type { Editor } from "@tiptap/core";
import { createContext, useCallback, useRef, useSyncExternalStore } from "react";
import type { Transaction } from "@tiptap/pm/state";
import { createEditorBackgroundTask } from "./editorBackgroundTask";
import { isOrdinaryTyping } from "./visualTyping";

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
export function useLatexEditingState(owner: Editor | null, deferTyping = false) {
  const editor = useLatexEditingTarget(owner);
  const observed = useRef({ editor, state: editor?.state ?? null, editable: editor?.isEditable });
  if (observed.current.editor !== editor)
    observed.current = { editor, state: editor?.state ?? null, editable: editor?.isEditable };
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!editor) return () => {};
      const task = createEditorBackgroundTask();
      const publish = () => {
        observed.current = { editor, state: editor.state, editable: editor.isEditable };
        listener();
      };
      const transaction = ({ transaction }: { transaction: Transaction }) => {
        if (deferTyping && isOrdinaryTyping(transaction)) task.schedule(publish);
        else {
          task.cancel();
          publish();
        }
      };
      const update = () => {
        if (!deferTyping || observed.current.editable !== editor.isEditable) publish();
      };
      editor.on("transaction", transaction);
      editor.on("update", update);
      return () => {
        task.cancel();
        editor.off("transaction", transaction);
        editor.off("update", update);
      };
    },
    [editor, deferTyping],
  );
  const snapshot = useCallback(
    () => (deferTyping ? observed.current.state : (editor?.state ?? null)),
    [editor, deferTyping],
  );
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { editor, state };
}
