import type { Editor } from "@tiptap/core";
import { createContext } from "react";

export const LatexInlineOwnerContext = createContext<Editor | null>(null);

// The document owns history/source; an inline field owns its local caret.
const targets = new WeakMap<Editor, Editor>();
export function activateLatexEditingTarget(owner: Editor, field: Editor): void {
  targets.set(owner, field);
}
export function clearLatexEditingTarget(owner: Editor, field?: Editor): void {
  if (!field || targets.get(owner) === field) targets.delete(owner);
}
export function latexEditingTarget(owner: Editor): Editor {
  if (!owner.isDestroyed && document.activeElement === owner.view.dom) {
    targets.delete(owner);
    return owner;
  }
  const field = targets.get(owner);
  return field && !field.isDestroyed ? field : owner;
}
