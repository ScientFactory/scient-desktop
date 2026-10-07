import type { MathViewportState } from "./latexMathViewport";

/** Panning is an equation option, with no extra controls on the paper. */
export function LatexMathScrollControl({
  state,
  onScroll,
}: {
  state: MathViewportState;
  onScroll: (offset: number) => void;
}) {
  if (state.max <= 0) return null;
  return (
    <label className="scient-latex-math-scroll-control">
      Scroll
      <input
        type="range"
        aria-label="Equation horizontal scroll"
        aria-valuetext={`${Math.round((state.offset / state.max) * 100)}%`}
        min={0}
        max={state.max}
        step="any"
        value={state.offset}
        onChange={(event) => onScroll(event.currentTarget.valueAsNumber)}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </label>
  );
}
