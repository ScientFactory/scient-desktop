import { normalizePdfZoom, type PdfZoomMode } from "./pdfReaderModel";

const PDF_VIEWER_HORIZONTAL_PADDING = 40;
const PDF_ZOOM_BOUNDARY_TOLERANCE = 0.005;
const ADAPTIVE_ZOOM_VALUES = new Set(["auto", "page-fit", "page-height", "page-width"]);

interface PdfResponsivePageView {
  readonly scale: number;
  readonly width: number;
}

export interface PdfResponsiveZoomTarget {
  currentPageNumber: number;
  currentScale: number;
  currentScaleValue: string;
  getPageView: (index: number) => PdfResponsivePageView | undefined;
  update: () => void;
}

export interface PdfResponsiveZoomController {
  readonly isConstrained: () => boolean;
  readonly persistedScaleValue: () => string;
  readonly capturePreference: (target: PdfResponsiveZoomTarget) => void;
  readonly observeScaleChange: (
    target: PdfResponsiveZoomTarget,
    scale: number,
    presetValue?: string,
  ) => boolean;
  readonly reconcile: (target: PdfResponsiveZoomTarget, containerWidth: number) => void;
  readonly rememberScale: (scale: number) => number;
  readonly rememberMode: (mode: PdfZoomMode) => void;
}

function normalizedScaleValue(value: string | null | undefined, fallbackScale: number): string {
  if (value && (ADAPTIVE_ZOOM_VALUES.has(value) || value === "page-actual")) return value;
  const numeric = Number(value);
  return String(
    normalizePdfZoom(Number.isFinite(numeric) && numeric > 0 ? numeric : fallbackScale),
  );
}

function fixedPreferredScale(value: string): number | null {
  if (value === "page-actual") return 1;
  if (ADAPTIVE_ZOOM_VALUES.has(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? normalizePdfZoom(numeric) : null;
}

function fitWidthScale(target: PdfResponsiveZoomTarget, containerWidth: number): number | null {
  const pageView = target.getPageView(target.currentPageNumber - 1);
  if (
    !pageView ||
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(pageView.width) ||
    !Number.isFinite(pageView.scale) ||
    pageView.width <= 0 ||
    pageView.scale <= 0
  ) {
    return null;
  }
  // Matches PDF.js's page-width calculation for the reader's default vertical
  // scroll mode and visible page borders. Keep this with the runtime config.
  const availableWidth = Math.max(0, containerWidth - PDF_VIEWER_HORIZONTAL_PADDING);
  return normalizePdfZoom((availableWidth / pageView.width) * pageView.scale);
}

export function createPdfResponsiveZoomController(): PdfResponsiveZoomController {
  let preferredScaleValue = "page-width";
  let constrained = false;
  let reconciling = false;

  const applyScale = (target: PdfResponsiveZoomTarget, value: number | string) => {
    if (typeof value === "number") target.currentScale = value;
    else target.currentScaleValue = value;
  };

  const reconcile = (target: PdfResponsiveZoomTarget, containerWidth: number) => {
    if (reconciling) return;
    reconciling = true;
    try {
      const preferredScale = fixedPreferredScale(preferredScaleValue);
      if (preferredScale === null) {
        constrained = false;
        applyScale(target, preferredScaleValue);
        return;
      }

      const fitScale = fitWidthScale(target, containerWidth);
      if (fitScale === null) {
        target.update();
        return;
      }
      const shouldConstrain = constrained
        ? fitScale < preferredScale + PDF_ZOOM_BOUNDARY_TOLERANCE
        : fitScale < preferredScale - PDF_ZOOM_BOUNDARY_TOLERANCE;
      const nextScale = shouldConstrain ? fitScale : preferredScale;
      constrained = shouldConstrain;
      if (
        Math.abs(target.currentScale - nextScale) < 1e-9 &&
        (shouldConstrain || target.currentScaleValue === preferredScaleValue)
      ) {
        target.update();
        return;
      }
      applyScale(target, shouldConstrain ? nextScale : preferredScaleValue);
    } finally {
      reconciling = false;
    }
  };

  return {
    isConstrained: () => constrained,
    persistedScaleValue: () => preferredScaleValue,
    capturePreference: (target) => {
      preferredScaleValue = normalizedScaleValue(target.currentScaleValue, target.currentScale);
      constrained = false;
    },
    observeScaleChange: (target, scale, presetValue) => {
      if (reconciling) return false;
      preferredScaleValue = normalizedScaleValue(presetValue ?? target.currentScaleValue, scale);
      constrained = false;
      return true;
    },
    reconcile,
    rememberScale: (scale) => {
      const normalized = normalizePdfZoom(scale);
      preferredScaleValue = String(normalized);
      constrained = false;
      return normalized;
    },
    rememberMode: (mode) => {
      preferredScaleValue = mode;
      constrained = false;
    },
  };
}
