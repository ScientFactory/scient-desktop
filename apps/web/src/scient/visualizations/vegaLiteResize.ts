export const VEGA_LITE_RESIZE_EPSILON = 0.5;

export function isMeaningfulVegaLiteWidthChange(
  previousWidth: number | null,
  nextWidth: number,
): boolean {
  return (
    Number.isFinite(nextWidth) &&
    nextWidth > 0 &&
    (previousWidth == null || Math.abs(nextWidth - previousWidth) >= VEGA_LITE_RESIZE_EPSILON)
  );
}
