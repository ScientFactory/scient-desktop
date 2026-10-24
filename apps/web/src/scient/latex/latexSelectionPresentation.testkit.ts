import { expect, vi } from "vite-plus/test";
import type { MathfieldElement } from "mathlive";
import { readLatexSelection } from "./latexSelectionSession";

const rectSnapshot = ({ x, y, width, height, top, right, bottom, left }: DOMRectReadOnly) => ({
  x,
  y,
  width,
  height,
  top,
  right,
  bottom,
  left,
});

/** A receipt from the selection owner's completed native geometry publication. */
export function observeLatexSelectionPresentation(root: HTMLElement) {
  const capture = () => {
    const current = readLatexSelection(root);
    if (!current) return null;
    const { element, snapshot } = current;
    const scopes = snapshot.scopes();
    const selection = snapshot.selection();
    const layer = root.querySelector<HTMLElement>(".scient-latex-selection-overlay");
    const origin = layer?.getBoundingClientRect();
    if ((scopes.length || selection.length) && (!origin || origin.width <= 0 || origin.height <= 0))
      return null;
    // Ancestor movement carries the painted layer with its ink. Preserve exact
    // viewport sizes and compare positions after that common translation.
    return {
      element,
      anchor: layer?.parentElement ?? null,
      origin: origin ? { x: origin.x, y: origin.y } : null,
      held: element.hasAttribute("data-scient-selection-held"),
      content: snapshot.content,
      path: snapshot.path,
      selectionKind: snapshot.selectionKind,
      selectionOverlay: snapshot.selectionOverlay,
      value:
        element.localName === "math-field"
          ? (element as MathfieldElement).getValue()
          : element.textContent,
      scopes: scopes.map(rectSnapshot),
      selection: selection.map(rectSnapshot),
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
        const { origin: before, scopes, selection, ...state } = published!;
        const {
          origin: after,
          scopes: currentScopes,
          selection: currentSelection,
          ...currentState
        } = current!;
        expect(state).toEqual(currentState);
        const dx = before && after ? after.x - before.x : 0;
        const dy = before && after ? after.y - before.y : 0;
        const translated = (rects: typeof scopes) =>
          rects.map((rect) =>
            rectSnapshot(new DOMRect(rect.x + dx, rect.y + dy, rect.width, rect.height)),
          );
        expect(translated(scopes)).toEqual(currentScopes);
        expect(translated(selection)).toEqual(currentSelection);
      });
    },
    [Symbol.dispose]() {
      root.removeEventListener("scient-latex-selection-scope", receive, true);
    },
  };
}
