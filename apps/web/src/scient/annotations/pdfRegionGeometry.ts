import type { PdfRect } from "@scientfactory/document-artifacts";

/** The part of a pdf.js `PageViewport` that maps PDF user space to the rendered page. */
export interface PdfPageViewport {
  /** `[a, b, c, d, e, f]`: PDF user space to viewport pixels, y down. */
  readonly transform: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** A point on the rendered page as a fraction of its width and height, from its top left. */
export interface PageFraction {
  readonly x: number;
  readonly y: number;
}

/** A box on the rendered page in fractions of its size, for percentage placement. */
export interface PageFractionBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function toViewport(viewport: PdfPageViewport, x: number, y: number): readonly [number, number] {
  const t = viewport.transform;
  return [t[0]! * x + t[2]! * y + t[4]!, t[1]! * x + t[3]! * y + t[5]!];
}

function toPdf(viewport: PdfPageViewport, x: number, y: number): readonly [number, number] | null {
  const [a, b, c, d, e, f] = Array.from(viewport.transform);
  const determinant = a! * d! - b! * c!;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  return [
    (d! * (x - e!) - c! * (y - f!)) / determinant,
    (a! * (y - f!) - b! * (x - e!)) / determinant,
  ];
}

/**
 * The PDF user-space box between two corners dragged on the rendered page, clipped to the
 * page's view box, or null when nothing of it is on the page. The reader's zoom and rotation
 * are undone here, so the stored box is the same however the page was shown.
 */
export function pdfRegionFromPageFractions(
  viewport: PdfPageViewport,
  viewBox: readonly [number, number, number, number],
  from: PageFraction,
  to: PageFraction,
): PdfRect | null {
  const corner = (point: PageFraction) =>
    toPdf(viewport, point.x * viewport.width, point.y * viewport.height);
  const one = corner(from);
  const two = corner(to);
  if (!one || !two) return null;
  const x1 = clamp(Math.min(one[0], two[0]), viewBox[0], viewBox[2]);
  const x2 = clamp(Math.max(one[0], two[0]), viewBox[0], viewBox[2]);
  const y1 = clamp(Math.min(one[1], two[1]), viewBox[1], viewBox[3]);
  const y2 = clamp(Math.max(one[1], two[1]), viewBox[1], viewBox[3]);
  if (!(x1 < x2 && y1 < y2)) return null;
  return [x1, y1, x2, y2];
}

/** Where a stored box sits on the page as currently rendered, in fractions of its size. */
export function pdfRegionPageBox(viewport: PdfPageViewport, rect: PdfRect): PageFractionBox {
  const [ax, ay] = toViewport(viewport, rect[0], rect[1]);
  const [bx, by] = toViewport(viewport, rect[2], rect[3]);
  const left = Math.min(ax, bx);
  const top = Math.min(ay, by);
  return {
    left: left / viewport.width,
    top: top / viewport.height,
    width: Math.abs(bx - ax) / viewport.width,
    height: Math.abs(by - ay) / viewport.height,
  };
}
