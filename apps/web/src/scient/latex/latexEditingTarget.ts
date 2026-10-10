import type { Editor } from "@tiptap/core";
import { createContext, useCallback, useRef, useSyncExternalStore } from "react";
import { NodeSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { countSelectedWords } from "../writing/caretStatus";
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

interface EditingSnapshot<T> {
  editor: Editor | null;
  state: EditorState | null;
  editable: boolean | undefined;
  value: T;
}

/** Keep commands on the live editor while subscriptions publish only their selected data. */
function useLatexEditingSnapshot<T>(
  owner: Editor | null,
  deferTyping: boolean,
  select: (editor: Editor | null) => T,
  equal: (before: T, after: T) => boolean,
) {
  const editor = useLatexEditingTarget(owner);
  const selected = useRef<EditingSnapshot<T> | null>(null);
  const observed = useRef<EditingSnapshot<T> | null>(null);
  const read = useCallback(() => {
    const state = editor?.state ?? null;
    const editable = editor?.isEditable;
    if (
      !selected.current ||
      selected.current.editor !== editor ||
      selected.current.state !== state ||
      selected.current.editable !== editable
    )
      selected.current = { editor, state, editable, value: select(editor) };
    return selected.current;
  }, [editor, select]);
  const same = useCallback(
    (before: EditingSnapshot<T>, after: EditingSnapshot<T>) =>
      before.editor === after.editor &&
      before.editable === after.editable &&
      equal(before.value, after.value),
    [equal],
  );
  if (observed.current?.editor !== editor) observed.current = read();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!editor) return () => {};
      const task = createEditorBackgroundTask();
      const publish = () => {
        const next = read();
        if (observed.current && same(observed.current, next)) return;
        observed.current = next;
        listener();
      };
      const transaction = ({ transaction }: { transaction: Transaction }) => {
        // Layout/reference metadata has its own presentation subscriptions.
        // It must not publish a pending typing snapshot before its quiet period.
        if (
          deferTyping &&
          !transaction.docChanged &&
          !transaction.selectionSet &&
          !transaction.storedMarksSet &&
          observed.current?.editable === editor.isEditable
        )
          return;
        if (deferTyping && isOrdinaryTyping(transaction)) task.schedule(publish);
        else {
          task.cancel();
          publish();
        }
      };
      const update = () => {
        if (!deferTyping || observed.current?.editable !== editor.isEditable) publish();
      };
      editor.on("transaction", transaction);
      editor.on("update", update);
      return () => {
        task.cancel();
        editor.off("transaction", transaction);
        editor.off("update", update);
      };
    },
    [editor, deferTyping, read, same],
  );
  const snapshot = useCallback(() => {
    const next = !deferTyping || !observed.current ? read() : observed.current;
    if (!observed.current || !same(observed.current, next)) observed.current = next;
    return observed.current;
  }, [deferTyping, read, same]);
  // Editability can change without replacing EditorState. Include it in the
  // stable snapshot so formatting controls still react to that transition.
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { editor, value: state.value };
}

const editingState = (editor: Editor | null) => editor?.state ?? null;

/** Read the new target immediately, even before it emits its next transaction. */
export function useLatexEditingState(owner: Editor | null, deferTyping = false) {
  const { editor, value } = useLatexEditingSnapshot(owner, deferTyping, editingState, Object.is);
  return { editor, state: value };
}

interface EditingPresentation {
  formattingAvailable: boolean;
  bold: boolean;
  italic: boolean;
  code: boolean;
  selectedWords: number | null;
}

function editingPresentation(editor: Editor | null): EditingPresentation {
  const selection = editor?.state.selection;
  return {
    formattingAvailable: Boolean(
      editor?.isEditable &&
      selection &&
      !(selection instanceof NodeSelection) &&
      selection.$from.parent.isTextblock,
    ),
    bold: editor?.isActive("bold") ?? false,
    italic: editor?.isActive("italic") ?? false,
    code: editor?.isActive("code") ?? false,
    selectedWords: editor ? countSelectedWords(editor.state) : null,
  };
}

const sameEditingPresentation = (before: EditingPresentation, after: EditingPresentation) =>
  before.formattingAvailable === after.formattingAvailable &&
  before.bold === after.bold &&
  before.italic === after.italic &&
  before.code === after.code &&
  before.selectedWords === after.selectedWords;

/** Typing at a collapsed caret need not render unchanged controls. Selection,
 * formatting, ownership and editability changes still publish immediately.
 */
export function useLatexEditingPresentation(owner: Editor | null) {
  const { editor, value } = useLatexEditingSnapshot(
    owner,
    false,
    editingPresentation,
    sameEditingPresentation,
  );
  return { editor, ...value };
}
