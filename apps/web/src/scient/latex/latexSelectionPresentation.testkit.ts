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
  let publishedAt: number | null = null;
  const receive = () => {
    published = capture();
    publishedAt = performance.now();
  };
  root.addEventListener("scient-latex-selection-scope", receive, true);
  return {
    async wait() {
      try {
        // The browser default is 5 s for eventual readiness. A publication that lags the
        // live selection by more than a second is a visible repaint delay, so this keeps 1 s.
        await vi.waitFor(
          () => {
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
          },
          { timeout: 1_000 },
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${describePresentation(root, published?.origin ?? null, publishedAt)}`,
          { cause: error },
        );
      }
    },
    [Symbol.dispose]() {
      root.removeEventListener("scient-latex-selection-scope", receive, true);
    },
  };
}

const formatRect = (rect: DOMRect | undefined) =>
  rect
    ? `(${rect.x.toFixed(2)}, ${rect.y.toFixed(2)}) ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`
    : "none";

/**
 * Tells a whole-field move (every rectangle shifted with its scroller: harmless) from a
 * misplaced outline (the overlay or field moved alone: a presentation bug).
 */
function describePresentation(
  root: HTMLElement,
  publishedOrigin: { x: number; y: number } | null,
  publishedAt: number | null,
) {
  const field = readLatexSelection(root)?.element;
  const overlay = root.querySelector<HTMLElement>(".scient-latex-selection-overlay");
  const scrolls: string[] = [];
  for (let node: HTMLElement | null = field ?? root; node; node = node.parentElement) {
    if (node.scrollTop || node.scrollLeft)
      scrolls.push(
        `${node.localName}.${[...node.classList].join(".")} ${node.scrollLeft},${node.scrollTop}`,
      );
  }
  const published = publishedOrigin
    ? `(${publishedOrigin.x.toFixed(2)}, ${publishedOrigin.y.toFixed(2)})`
    : "none";
  return [
    `scroll offsets (left,top): ${scrolls.join("; ") || "none"}; window ${scrollX},${scrollY}`,
    `overlay origin: now ${formatRect(overlay?.getBoundingClientRect())}, at publish ${published}`,
    `field rect: ${formatRect(field?.getBoundingClientRect())}`,
    `since last publish: ${publishedAt === null ? "never published" : `${(performance.now() - publishedAt).toFixed(1)} ms`}`,
  ].join("\n");
}
