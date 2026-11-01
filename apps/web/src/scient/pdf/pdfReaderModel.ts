const PDF_MIN_ZOOM = 0.25;
const PDF_MAX_ZOOM = 5;
const PDF_ZOOM_STEP_PERCENT = 5;
// The width page-width leaves around a page: PDF.js's own allowance, which the LaTeX
// visual editor matches. The PDF reader passes 0, because its margin is a border.
export const PDF_FIT_WIDTH_PADDING = 40;

export type PdfSidebarMode = "closed" | "thumbnails" | "outline";
export type PdfZoomMode = "page-width" | "page-fit" | "page-actual";

export function clampPdfPage(page: number, pageCount: number): number {
  if (pageCount <= 0) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}

export function parsePdfPageInput(value: string, pageCount: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= pageCount ? parsed : null;
}

export function nextPdfRotation(rotation: number): number {
  return ((rotation % 360) + 450) % 360;
}

export function formatPdfZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** Both readers measure physical pages in CSS pixels at 100% zoom. */
export function pdfFitWidthScale(
  containerWidth: number,
  pageWidth: number,
  padding = PDF_FIT_WIDTH_PADDING,
): number | null {
  if (
    !Number.isFinite(containerWidth) ||
    containerWidth <= 0 ||
    !Number.isFinite(pageWidth) ||
    pageWidth <= 0
  )
    return null;
  return Math.max(0, containerWidth - padding) / pageWidth;
}

/**
 * PDF.js measures a zoom origin from the container's offsetTop/offsetLeft, which are
 * relative to its positioned parent, not the window. Inside Scient's panels that put
 * every zoom's anchor too far right and down, so zooming drifted. This converts a point
 * on screen into the coordinates PDF.js expects.
 */
export function pdfZoomOrigin(
  viewer: { readonly containerTopLeft: number[] },
  container: {
    readonly getBoundingClientRect: () => { readonly left: number; readonly top: number };
    readonly clientLeft: number;
    readonly clientTop: number;
  },
  clientX: number,
  clientY: number,
): [number, number] {
  const rect = container.getBoundingClientRect();
  const [top = 0, left = 0] = viewer.containerTopLeft;
  return [
    clientX - rect.left - container.clientLeft + left,
    clientY - rect.top - container.clientTop + top,
  ];
}

export function normalizePdfZoom(scale: number): number {
  return Math.min(Math.max(scale, PDF_MIN_ZOOM), PDF_MAX_ZOOM);
}

export function stepPdfZoom(scale: number, direction: "in" | "out"): number {
  const percent = normalizePdfZoom(scale) * 100;
  const epsilon = 0.001;
  const steppedPercent =
    direction === "in"
      ? Math.ceil((percent + epsilon) / PDF_ZOOM_STEP_PERCENT) * PDF_ZOOM_STEP_PERCENT
      : Math.floor((percent - epsilon) / PDF_ZOOM_STEP_PERCENT) * PDF_ZOOM_STEP_PERCENT;
  return normalizePdfZoom(steppedPercent / 100);
}

export function parseSafePdfExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
