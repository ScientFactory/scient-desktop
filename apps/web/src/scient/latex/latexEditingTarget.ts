import type { Editor } from "@tiptap/core";
import { createContext, useState, useSyncExternalStore } from "react";
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
  const subscribe = (listener: () => void) => {
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
  };
  const snapshot = () => (owner ? latexEditingTarget(owner) : null);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

interface EditingSnapshot<T> {
  editor: Editor | null;
  state: EditorState | null;
  editable: boolean | undefined;
  value: T;
}

interface EditingSnapshotStore<T> {
  readonly editor: Editor | null;
  readonly deferTyping: boolean;
  readonly select: (editor: Editor | null) => T;
  readonly equal: (before: T, after: T) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => EditingSnapshot<T>;
}

/**
 * One editor's cached selected data. The store, not render, holds the last
 * published snapshot, so a quiet typing period keeps its identity.
 */
function createEditingSnapshotStore<T>(
  editor: Editor | null,
  deferTyping: boolean,
  select: (editor: Editor | null) => T,
  equal: (before: T, after: T) => boolean,
): EditingSnapshotStore<T> {
  let selected: EditingSnapshot<T> | null = null;
  let observed: EditingSnapshot<T> | null = null;
  const read = () => {
    const state = editor?.state ?? null;
    const editable = editor?.isEditable;
    if (
      !selected ||
      selected.editor !== editor ||
      selected.state !== state ||
      selected.editable !== editable
    )
      selected = { editor, state, editable, value: select(editor) };
    return selected;
  };
  const same = (before: EditingSnapshot<T>, after: EditingSnapshot<T>) =>
    before.editor === after.editor &&
    before.editable === after.editable &&
    equal(before.value, after.value);
  observed = read();
  return {
    editor,
    deferTyping,
    select,
    equal,
    subscribe: (listener) => {
      if (!editor) return () => {};
      const task = createEditorBackgroundTask();
      const publish = () => {
        const next = read();
        if (observed && same(observed, next)) return;
        observed = next;
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
          observed?.editable === editor.isEditable
        )
          return;
        if (deferTyping && isOrdinaryTyping(transaction)) task.schedule(publish);
        else {
          task.cancel();
          publish();
        }
      };
      const update = () => {
        if (!deferTyping || observed?.editable !== editor.isEditable) publish();
      };
      editor.on("transaction", transaction);
      editor.on("update", update);
      return () => {
        task.cancel();
        editor.off("transaction", transaction);
        editor.off("update", update);
      };
    },
    snapshot: () => {
      const next = !deferTyping || !observed ? read() : observed;
      if (!observed || !same(observed, next)) observed = next;
      return observed;
    },
  };
}

/** Keep commands on the live editor while subscriptions publish only their selected data. */
function useLatexEditingSnapshot<T>(
  owner: Editor | null,
  deferTyping: boolean,
  select: (editor: Editor | null) => T,
  equal: (before: T, after: T) => boolean,
) {
  const editor = useLatexEditingTarget(owner);
  // Held in state so its cached snapshot outlives compiler cache eviction;
  // a new target or selection starts a new store.
  const [store, setStore] = useState(() =>
    createEditingSnapshotStore(editor, deferTyping, select, equal),
  );
  let current = store;
  if (
    store.editor !== editor ||
    store.deferTyping !== deferTyping ||
    store.select !== select ||
    store.equal !== equal
  ) {
    current = createEditingSnapshotStore(editor, deferTyping, select, equal);
    setStore(current);
  }
  // Editability can change without replacing EditorState. Include it in the
  // stable snapshot so formatting controls still react to that transition.
  const state = useSyncExternalStore(current.subscribe, current.snapshot, current.snapshot);
  return { editor, value: state.value, editable: state.editable };
}

const editingState = (editor: Editor | null) => editor?.state ?? null;

/** Read the new target immediately, even before it emits its next transaction. */
export function useLatexEditingState(owner: Editor | null, deferTyping = false) {
  const { editor, value, editable } = useLatexEditingSnapshot(
    owner,
    deferTyping,
    editingState,
    Object.is,
  );
  return { editor, state: value, editable };
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
