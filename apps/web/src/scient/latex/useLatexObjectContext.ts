import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import {
  activateLatexContext,
  isLatexEditingMenuEvent,
  latexContextRoot,
} from "./latexContextEvents";

const selectionRoots = new WeakMap<EditorState, Element | null>();
function selectionRoot(editor: Editor): Element | null {
  if (selectionRoots.has(editor.state)) return selectionRoots.get(editor.state) ?? null;
  const node = editor.view.domAtPos(editor.state.selection.from).node;
  const target = node instanceof Element ? node : node.parentElement;
  const root = target?.closest("[data-latex-context-root]") ?? null;
  selectionRoots.set(editor.state, root);
  return root;
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
    const outside = (event: Event) => {
      if (isLatexEditingMenuEvent(event, element)) return;
      if (!event.composedPath().includes(element)) changeActive(false);
    };
    const other = (event: Event) => {
      changeActive((event as CustomEvent<string>).detail === id);
    };
    element.addEventListener("focusin", entered);
    element.addEventListener("pointerdown", entered);
    element.addEventListener("scient-latex-object-activate", entered);
    editor.on("selectionUpdate", moved);
    document.addEventListener("focusin", outside);
    document.addEventListener("pointerdown", outside);
    scope.addEventListener("scient-latex-context-activate", other);
    return () => {
      if (element.dataset.latexContextRoot === id)
        element.removeAttribute("data-latex-context-root");
      element.removeEventListener("focusin", entered);
      element.removeEventListener("pointerdown", entered);
      element.removeEventListener("scient-latex-object-activate", entered);
      editor.off("selectionUpdate", moved);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("pointerdown", outside);
      scope.removeEventListener("scient-latex-context-activate", other);
    };
  }, [editor, id, root]);
  useEffect(() => {
    if (selected) activateLatexContext(editor.view.dom, id);
  }, [editor, id, selected]);
  return { active, bar, id };
}
