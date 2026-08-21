export interface ScientSplitFractionBounds {
  readonly minimum: number;
  readonly fallback: number;
}

export function clampScientSplitFraction(value: number, bounds: ScientSplitFractionBounds): number {
  if (!Number.isFinite(value)) return bounds.fallback;
  return Math.min(Math.max(value, bounds.minimum), 1 - bounds.minimum);
}

export function scientSplitFractionFromPointer(
  input: {
    readonly pointerX: number;
    readonly left: number;
    readonly width: number;
  },
  bounds: ScientSplitFractionBounds,
): number {
  if (input.width <= 0) return bounds.fallback;
  return clampScientSplitFraction((input.pointerX - input.left) / input.width, bounds);
}

export function nudgeScientSplitFraction(
  current: number,
  key: string,
  bounds: ScientSplitFractionBounds,
  step: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampScientSplitFraction(current - step, bounds);
    case "ArrowRight":
      return clampScientSplitFraction(current + step, bounds);
    case "Home":
      return bounds.minimum;
    case "End":
      return 1 - bounds.minimum;
    default:
      return null;
  }
}
