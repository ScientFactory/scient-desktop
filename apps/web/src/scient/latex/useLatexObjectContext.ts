import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import {
  activateLatexContext,
  isLatexEditingMenuEvent,
  latexContextRoot,
} from "./latexContextEvents";

const selectionTargets = new WeakMap<EditorState, Element>();
function selectionRoot(editor: Editor): Element | null {
  let target = selectionTargets.get(editor.state);
  if (!target || !editor.view.dom.contains(target)) {
    const node = editor.view.domAtPos(editor.state.selection.from).node;
    target = (node instanceof Element ? node : node.parentElement) ?? undefined;
    if (target) selectionTargets.set(editor.state, target);
  }
  // Context roots can mount or change without a new ProseMirror selection.
  return target?.closest("[data-latex-context-root]") ?? null;
}

interface ObjectContext {
  readonly id: string;
  readonly element: Element;
  readonly change: (active: boolean) => void;
}

/**
 * One set of editor, document and window listeners per editor decides which
 * object owns the footer. A long document has an object for every reference,
 * so per-object listeners made every selection change and focus event run
 * thousands of handlers.
 */
function objectContexts(editor: Editor) {
  const objects = new Map<Element, ObjectContext>();
  let active: ObjectContext | null = null;
  const set = (next: ObjectContext | null) => {
    if (next === active) return;
    active?.change(false);
    active = next;
    next?.change(true);
  };
  const activate = (object: ObjectContext) => {
    if (object !== active) activateLatexContext(editor.view.dom, object.id);
  };
  const select = (root: Element | null) => {
    const object = root && objects.get(root);
    if (object) activate(object);
    else set(null);
  };
  // The object holding focus, or the caret when the editor itself is focused.
  const focusedRoot = (): Element | null | undefined => {
    const focused = editor.view.dom.ownerDocument.activeElement;
    const root = focused?.closest("[data-latex-context-root]");
    if (root) return root;
    if (focused && editor.view.dom.contains(focused)) return selectionRoot(editor);
    return undefined;
  };
  const restore = () => {
    if (editor.isDestroyed) return;
    const root = focusedRoot();
    if (root !== undefined) select(root);
  };
  const moved = () => {
    if (!editor.isFocused || !editor.state.selection.empty) return;
    select(selectionRoot(editor));
  };
  const outside = (event: Event) => {
    if (isLatexEditingMenuEvent(event, editor.view.dom)) return;
    const document = editor.view.dom.ownerDocument;
    // App switching and removal of a focused field can briefly focus the page.
    // Actual outside clicks still clear ownership through pointerdown.
    if (event.type === "focusin" && event.target === document.body) return;
    // ProseMirror focuses its shared contenteditable, not the nested object.
    if (event.type === "focusin" && event.target === editor.view.dom) {
      restore();
      return;
    }
    if (active && !event.composedPath().includes(active.element)) set(null);
  };
  const other = (event: Event) => {
    const id = (event as CustomEvent<string>).detail;
    set([...objects.values()].find((object) => object.id === id) ?? null);
  };
  let scope: Element | null = null;
  return {
    add(object: ObjectContext) {
      objects.set(object.element, object);
      if (objects.size === 1) {
        scope = latexContextRoot(editor.view.dom);
        editor.on("selectionUpdate", moved);
        editor.on("focus", restore);
        document.addEventListener("focusin", outside);
        document.addEventListener("pointerdown", outside);
        window.addEventListener("focus", restore);
        scope.addEventListener("scient-latex-context-activate", other);
      }
      // A newly mounted object takes the footer if it already holds the focus or caret.
      queueMicrotask(() => {
        if (objects.get(object.element) === object && !editor.isDestroyed)
          if (focusedRoot() === object.element) activate(object);
      });
    },
    remove(object: ObjectContext) {
      if (objects.get(object.element) !== object) return;
      objects.delete(object.element);
      if (active === object) active = null;
      if (objects.size > 0) return;
      editor.off("selectionUpdate", moved);
      editor.off("focus", restore);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("focus", restore);
      scope?.removeEventListener("scient-latex-context-activate", other);
      scope = null;
    },
    activate,
  };
}

const contexts = new WeakMap<Editor, ReturnType<typeof objectContexts>>();

/** The nearest editable object owns the footer, including when reached with the keyboard. */
export function useLatexObjectContext(
  editor: Editor,
  root: RefObject<HTMLElement | null>,
  selected: boolean,
) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.setAttribute("data-latex-context-root", id);
    let shared = contexts.get(editor);
    if (!shared) contexts.set(editor, (shared = objectContexts(editor)));
    const object: ObjectContext = { id, element, change: setActive };
    const entered = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-latex-context-root]") === element)
        shared.activate(object);
    };
    element.addEventListener("focusin", entered);
    element.addEventListener("pointerdown", entered);
    element.addEventListener("scient-latex-object-activate", entered);
    shared.add(object);
    return () => {
      shared.remove(object);
      if (element.dataset.latexContextRoot === id)
        element.removeAttribute("data-latex-context-root");
      element.removeEventListener("focusin", entered);
      element.removeEventListener("pointerdown", entered);
      element.removeEventListener("scient-latex-object-activate", entered);
    };
  }, [editor, id, root]);
  useEffect(() => {
    if (selected) activateLatexContext(editor.view.dom, id);
  }, [editor, id, selected]);
  return { active, bar, id };
}
