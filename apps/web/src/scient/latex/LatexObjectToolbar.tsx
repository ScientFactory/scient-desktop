import { isLatexContextEvent } from "./latexContextEvents";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";

/** Object controls occupy the existing footer; selecting content never changes its paper layout. */
export function LatexObjectToolbar(props: {
  editor: Editor;
  root: RefObject<HTMLElement | null>;
  selected: boolean;
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!props.selected) return;
    document.dispatchEvent(new CustomEvent("scient-latex-context-activate", { detail: id }));
    setActive(true);
  }, [id, props.selected]);
  useEffect(() => {
    const element = props.root.current;
    const activate = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-node-view-wrapper]") !== element)
        return;
      document.dispatchEvent(new CustomEvent("scient-latex-context-activate", { detail: id }));
      setActive(true);
    };
    const outside = (event: Event) => {
      if (isLatexContextEvent(event, bar.current)) return;
      const path = event.composedPath();
      if (!path.includes(element!) && !path.includes(bar.current!)) setActive(false);
    };
    const other = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setActive(false);
    };
    element?.addEventListener("focusin", activate);
    element?.addEventListener("pointerdown", activate);
    document.addEventListener("focusin", outside);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scient-latex-context-activate", other);
    return () => {
      element?.removeEventListener("focusin", activate);
      element?.removeEventListener("pointerdown", activate);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scient-latex-context-activate", other);
    };
  }, [id, props.root]);
  const host = props.editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  if (!active || !host || !props.editor.isEditable) return null;
  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label={props.label}
      className="scient-latex-context-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
      onFocusCapture={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {props.children}
    </div>,
    host,
  );
}
