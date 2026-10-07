import { type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useLatexObjectContext } from "./useLatexObjectContext";

/** Object controls occupy the existing footer; selecting content never changes its paper layout. */
export function LatexObjectToolbar(props: {
  editor: Editor;
  root: RefObject<HTMLElement | null>;
  selected: boolean;
  label: string;
  position?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  const { active, bar } = useLatexObjectContext(props.editor, props.root, props.selected);
  const host = props.editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  if (!active || !host || !props.editor.isEditable) return null;
  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label={props.label}
      data-context-position={props.position}
      data-context-presentation={props.inline ? "inline" : undefined}
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
