import { expect, vi } from "vite-plus/test";
import type { MathfieldElement } from "mathlive";
import { readLatexSelection } from "./latexSelectionSession";

/** A receipt from the selection owner's completed native geometry publication. */
export function observeLatexSelectionPresentation(root: HTMLElement) {
  const capture = () => {
    const current = readLatexSelection(root);
    if (!current) return null;
    const { element, snapshot } = current;
    return {
      element,
      held: element.hasAttribute("data-scient-selection-held"),
      content: snapshot.content,
      path: snapshot.path,
      selectionKind: snapshot.selectionKind,
      selectionOverlay: snapshot.selectionOverlay,
      value:
        element.localName === "math-field"
          ? (element as MathfieldElement).getValue()
          : element.textContent,
      scopes: snapshot.scopes().map((rect) => rect.toJSON()),
      selection: snapshot.selection().map((rect) => rect.toJSON()),
    };
  };
  let published: ReturnType<typeof capture> = null;
  const receive = () => {
    published = capture();
  };
  root.addEventListener("scient-latex-selection-scope", receive, true);
  return {
    async wait() {
      await vi.waitFor(() => {
        const current = capture();
        expect(current).not.toBeNull();
        expect(published?.element).toBe(current?.element);
        expect(published).toEqual(current);
      });
    },
    [Symbol.dispose]() {
      root.removeEventListener("scient-latex-selection-scope", receive, true);
    },
  };
}
