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

// Half of Chrome's 1/64px layout unit. Adding a measured translation to a measured
// position can differ from the browser's own measurement by float rounding alone,
// while any real misplacement is at least one layout unit.
const POSITION_TOLERANCE = 1 / 128;

/** Sizes are exact; positions must match after the common translation. */
function expectTranslated(
  published: ReadonlyArray<ReturnType<typeof rectSnapshot>>,
  current: ReadonlyArray<ReturnType<typeof rectSnapshot>>,
  dx: number,
  dy: number,
) {
  expect(published.map(({ width, height }) => ({ width, height }))).toEqual(
    current.map(({ width, height }) => ({ width, height })),
  );
  const offsets = published.flatMap((rect, index) => {
    const now = current[index]!;
    return [
      rect.x + dx - now.x,
      rect.left + dx - now.left,
      rect.right + dx - now.right,
      rect.y + dy - now.y,
      rect.top + dy - now.top,
      rect.bottom + dy - now.bottom,
    ];
  });
  expect(offsets.filter((offset) => Math.abs(offset) > POSITION_TOLERANCE)).toEqual([]);
}

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
        expectTranslated(scopes, currentScopes, dx, dy);
        expectTranslated(selection, currentSelection, dx, dy);
      });
    },
    [Symbol.dispose]() {
      root.removeEventListener("scient-latex-selection-scope", receive, true);
    },
  };
}
