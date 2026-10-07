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

/** The nearest editable object owns the footer, including when reached with the keyboard. */
export function useLatexObjectContext(
  editor: Editor,
  root: RefObject<HTMLElement | null>,
  selected: boolean,
) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const activeState = useRef(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.setAttribute("data-latex-context-root", id);
    const scope = latexContextRoot(editor.view.dom);
    const changeActive = (next: boolean) => {
      if (activeState.current === next) return;
      activeState.current = next;
      setActive(next);
    };
    const activate = () => {
      if (activeState.current) return;
      activateLatexContext(editor.view.dom, id);
      changeActive(true);
    };
    const entered = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-latex-context-root]") === element)
        activate();
    };
    const moved = () => {
      if (!editor.isFocused || !editor.state.selection.empty) return;
      if (selectionRoot(editor) === element) activate();
      else changeActive(false);
    };
    const restore = () => {
      if (editor.isDestroyed) return;
      const focused = element.ownerDocument.activeElement;
      const focusedRoot = focused?.closest("[data-latex-context-root]");
      if (focusedRoot) {
        if (focusedRoot === element) activate();
        else changeActive(false);
      } else if (focused && editor.view.dom.contains(focused)) {
        if (selectionRoot(editor) === element) activate();
        else changeActive(false);
      }
    };
    const outside = (event: Event) => {
      if (isLatexEditingMenuEvent(event, element)) return;
      // App switching and removal of a focused field can briefly focus the page.
      // Actual outside clicks still clear ownership through pointerdown.
      if (event.type === "focusin" && event.target === element.ownerDocument.body) return;
      // ProseMirror focuses its shared contenteditable, not the nested object.
      if (event.type === "focusin" && event.target === editor.view.dom) {
        restore();
        return;
      }
      if (!event.composedPath().includes(element)) changeActive(false);
    };
    const other = (event: Event) => {
      changeActive((event as CustomEvent<string>).detail === id);
    };
    element.addEventListener("focusin", entered);
    element.addEventListener("pointerdown", entered);
    element.addEventListener("scient-latex-object-activate", entered);
    editor.on("selectionUpdate", moved);
    editor.on("focus", restore);
    document.addEventListener("focusin", outside);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("focus", restore);
    scope.addEventListener("scient-latex-context-activate", other);
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) restore();
    });
    return () => {
      mounted = false;
      if (element.dataset.latexContextRoot === id)
        element.removeAttribute("data-latex-context-root");
      element.removeEventListener("focusin", entered);
      element.removeEventListener("pointerdown", entered);
      element.removeEventListener("scient-latex-object-activate", entered);
      editor.off("selectionUpdate", moved);
      editor.off("focus", restore);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("focus", restore);
      scope.removeEventListener("scient-latex-context-activate", other);
    };
  }, [editor, id, root]);
  useEffect(() => {
    if (selected) activateLatexContext(editor.view.dom, id);
  }, [editor, id, selected]);
  return { active, bar, id };
}
