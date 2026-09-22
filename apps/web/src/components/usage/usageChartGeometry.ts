export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
function monotoneTangents(points: readonly ChartPoint[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

/** A smooth path that preserves every measured point without inventing new extrema. */
export function shapePreservingCurvePath(points: readonly ChartPoint[]): string {
  const first = points[0];
  if (first === undefined) return "";
  let path = `M${first.x.toFixed(2)},${first.y.toFixed(2)}`;
  if (points.length === 1) return path;

  const tangents = monotoneTangents(points);
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    const c1 = {
      x: from.x + dx / 3,
      y: from.y + ((tangents[index] ?? 0) * dx) / 3,
    };
    const c2 = {
      x: to.x - dx / 3,
      y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3,
    };
    path += ` C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

/** Returns the exact Y position on the same shape-preserving curve used by the SVG path. */
export function shapePreservingCurveYAtX(points: readonly ChartPoint[], x: number): number {
  const first = points[0];
  if (first === undefined) return 0;
  const last = points.at(-1) ?? first;
  if (points.length === 1 || x <= first.x) return first.y;
  if (x >= last.x) return last.y;

  const tangents = monotoneTangents(points);
  const segmentIndex = points.findIndex((point) => point.x >= x) - 1;
  const from = points[Math.max(0, segmentIndex)] ?? first;
  const to = points[Math.max(1, segmentIndex + 1)] ?? last;
  const dx = to.x - from.x;
  if (dx <= 0) return from.y;

  const t = (x - from.x) / dx;
  const t2 = t * t;
  const t3 = t2 * t;
  const fromTangent = tangents[Math.max(0, segmentIndex)] ?? 0;
  const toTangent = tangents[Math.max(1, segmentIndex + 1)] ?? 0;
  return (
    (2 * t3 - 3 * t2 + 1) * from.y +
    (t3 - 2 * t2 + t) * dx * fromTangent +
    (-2 * t3 + 3 * t2) * to.y +
    (t3 - t2) * dx * toTangent
  );
}

/** Returns the exact vertical extent of a shape-preserving curve across one horizontal span. */
export function shapePreservingCurveYRangeBetweenX(
  points: readonly ChartPoint[],
  startX: number,
  endX: number,
): { readonly min: number; readonly max: number } | null {
  const first = points[0];
  if (first === undefined) return null;
  const last = points.at(-1) ?? first;
  const requestedLeft = Math.min(startX, endX);
  const requestedRight = Math.max(startX, endX);
  if (requestedRight < first.x || requestedLeft > last.x) return null;
  const left = Math.max(requestedLeft, first.x);
  const right = Math.min(requestedRight, last.x);
  const values = [
    shapePreservingCurveYAtX(points, left),
    shapePreservingCurveYAtX(points, right),
    ...points.filter((point) => point.x > left && point.x < right).map((point) => point.y),
  ];
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak. Rounding up prevents the tallest series from being clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

export function nearestPeriodIndex(localX: number, plotWidth: number, periodCount: number): number {
  if (periodCount <= 1 || plotWidth <= 0) return 0;
  const boundedX = Math.min(plotWidth, Math.max(0, localX));
  return Math.min(periodCount - 1, Math.round((boundedX / plotWidth) * (periodCount - 1)));
}

/** Selects the closest rendered curve while keeping the current one stable around crossings. */
export function nearestCurveIndex(input: {
  readonly curveYs: readonly number[];
  readonly pointerY: number;
  readonly previousIndex: number | null;
  readonly switchMargin?: number;
}): number | null {
  if (input.curveYs.length === 0) return null;

  let nearestIndex = 0;
  let nearestDistance = Math.abs((input.curveYs[0] ?? 0) - input.pointerY);
  for (let index = 1; index < input.curveYs.length; index += 1) {
    const distance = Math.abs((input.curveYs[index] ?? 0) - input.pointerY);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }

  const previousY = input.previousIndex === null ? undefined : input.curveYs[input.previousIndex];
  if (previousY === undefined || input.previousIndex === nearestIndex) return nearestIndex;

  const previousDistance = Math.abs(previousY - input.pointerY);
  const switchMargin = input.switchMargin ?? 5;
  return nearestDistance + switchMargin < previousDistance ? nearestIndex : input.previousIndex;
}

/** Keeps the transient card above its point while containing it horizontally within the plot. */
export function placeChartTooltip(input: {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly tooltipWidth: number;
  readonly tooltipHeight: number;
  readonly plotWidth: number;
  readonly gap?: number;
  readonly curveClearance?: number;
  readonly curveYRanges?: readonly { readonly min: number; readonly max: number }[];
  readonly maxCurveLift?: number;
}): { readonly left: number; readonly top: number } {
  const gap = input.gap ?? 20;
  const maxLeft = Math.max(0, input.plotWidth - input.tooltipWidth);
  const clampLeft = (value: number) => Math.min(Math.max(0, value), maxLeft);
  const canFitRight = input.anchorX + gap + input.tooltipWidth <= input.plotWidth;
  const canFitLeft = input.anchorX - gap - input.tooltipWidth >= 0;
  const preferRight = input.anchorX <= input.plotWidth / 2;
  const useRight = preferRight ? canFitRight || !canFitLeft : !canFitLeft;
  const sideLeft =
    canFitRight || canFitLeft
      ? useRight
        ? input.anchorX + gap
        : input.anchorX - gap - input.tooltipWidth
      : clampLeft(input.anchorX - input.tooltipWidth / 2);
  const baseTop = input.anchorY - gap - input.tooltipHeight;
  const minimumTop = baseTop - Math.max(0, input.maxCurveLift ?? Number.POSITIVE_INFINITY);
  let top = baseTop;
  const curveClearance = input.curveClearance ?? 10;
  const curveYRanges = input.curveYRanges ?? [];

  for (let pass = 0; pass < curveYRanges.length; pass += 1) {
    const bottom = top + input.tooltipHeight;
    const overlappingRanges = curveYRanges.filter((range) => {
      const min = Math.min(range.min, range.max) - curveClearance;
      const max = Math.max(range.min, range.max) + curveClearance;
      return bottom > min && top < max;
    });
    if (overlappingRanges.length === 0) break;
    const requiredTop = Math.min(
      ...overlappingRanges.map(
        (range) => Math.min(range.min, range.max) - curveClearance - input.tooltipHeight,
      ),
    );
    const nextTop = Math.max(minimumTop, requiredTop);
    if (nextTop >= top) break;
    top = nextTop;
    if (top === minimumTop) break;
  }

  return { left: sideLeft, top };
}
