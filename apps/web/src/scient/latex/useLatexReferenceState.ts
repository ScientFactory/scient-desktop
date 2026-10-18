import { useMemo, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { latexReferenceRevision } from "./latexEquationReferences";

interface ReferenceStore {
  readonly subscribe: (listener: () => void) => () => void;
}

const stores = new WeakMap<Editor, ReferenceStore>();

/** One transaction listener per editor, however many views read references. */
function referenceStore(editor: Editor): ReferenceStore {
  const existing = stores.get(editor);
  if (existing) return existing;
  const listeners = new Set<() => void>();
  let counted = latexReferenceRevision(editor.state);
  const store: ReferenceStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const changed = () => {
    const next = latexReferenceRevision(editor.state);
    if (next === counted) return;
    counted = next;
    for (const listener of listeners) listener();
  };
  editor.on("transaction", changed);
  editor.on("destroy", () => {
    editor.off("transaction", changed);
    listeners.clear();
  });
  stores.set(editor, store);
  return store;
}

const unsubscribed = () => () => {};

/**
 * A view's numbering, read from the references and its own position. Unlike
 * `useEditorState`, it is not recomputed on every transaction: ordinary typing
 * and loading only move positions, which leaves every number unchanged. It is
 * recomputed when references are counted again or the view renders. Values
 * must be plain data.
 */
export function useLatexReferenceState<T>(
  editor: Editor | null,
  select: (editor: Editor) => T,
): T | null {
  const store = editor ? referenceStore(editor) : null;
  // The snapshot is the value as JSON, so a recount re-renders only the views
  // whose value changed, and an equal value keeps its identity.
  const json = useSyncExternalStore(store?.subscribe ?? unsubscribed, () =>
    JSON.stringify(editor && !editor.isDestroyed ? (select(editor) ?? null) : null),
  );
  return useMemo(() => JSON.parse(json) as T | null, [json]);
}
