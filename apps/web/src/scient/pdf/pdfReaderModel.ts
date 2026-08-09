export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 5;
export const PDF_ZOOM_STEP_PERCENT = 5;

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
