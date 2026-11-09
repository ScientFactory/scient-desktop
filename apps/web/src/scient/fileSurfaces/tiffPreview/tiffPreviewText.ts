import type { TiffAxisName, TiffPreviewInfo } from "./tiffPreview";

type Format = TiffPreviewInfo["format"];

const MINUS = "−";

export function formatTiffValue(value: number, format: Format) {
  const magnitude = Math.abs(value);
  const text =
    format !== "float"
      ? Math.round(value).toLocaleString()
      : magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)
        ? value.toExponential(2).replace("e+", "e")
        : Number(value.toPrecision(4)).toLocaleString(undefined, { maximumFractionDigits: 6 });
  return text.replace(/^-/u, MINUS);
}

/** "31–431", or "−0.85 to 0.65" when a minus sign would sit next to the dash. */
export function tiffRangeText(range: readonly [number, number], format: Format) {
  const [low, high] = range.map((value) => formatTiffValue(value, format));
  return range[0] < 0 || range[1] < 0 ? `${low} to ${high}` : `${low}–${high}`;
}

/**
 * Width, in digit widths, that any range of this sample type fits in, so stepping planes never
 * changes how the toolbar wraps.
 */
export function tiffRangeWidth(info: Pick<TiffPreviewInfo, "bits" | "format">) {
  if (info.format === "float") return `${MINUS}1.23e-12 to ${MINUS}1.23e-12`.length;
  if (info.format === "int") {
    const widest = formatTiffValue(-(2 ** (Math.min(info.bits, 53) - 1)), "int");
    return `${widest} to ${widest}`.length;
  }
  const widest = formatTiffValue(2 ** Math.min(info.bits, 53) - 1, "uint");
  return `${widest}–${widest}`.length;
}

const AXIS_ORDER: Readonly<Record<TiffAxisName, number>> = { C: 0, Z: 1, T: 2 };

export interface TiffAxisStep {
  readonly name: TiffAxisName;
  readonly index: number;
  readonly size: number;
  /** Planes between neighbouring positions on this axis. */
  readonly stride: number;
}

/** Position on each named axis with more than one position, in C, Z, T order. */
export function tiffAxisSteps(plane: number, axes: TiffPreviewInfo["axes"]): TiffAxisStep[] {
  let stride = 1;
  return axes
    .map((axis) => {
      const step = {
        name: axis.name,
        index: Math.floor(plane / stride) % axis.size,
        size: axis.size,
        stride,
      };
      stride *= axis.size;
      return step;
    })
    .filter((step) => step.size > 1)
    .toSorted((left, right) => AXIS_ORDER[left.name] - AXIS_ORDER[right.name]);
}
