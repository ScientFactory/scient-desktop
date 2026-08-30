import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  type DesktopPreviewPdfExportArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { WebContents } from "electron";

const READINESS_TIMEOUT_MS = 2_500;
const MAX_TITLE_LENGTH = 512;
// printToPDF margins are measured in inches. Manual Browser export gets a
// small readable fallback; controlled document builds instead let the
// source's @page rule own physical page geometry without a second margin.
const READABLE_FALLBACK_MARGIN_INCHES = 1 / 6;
// Chromium lays an un-sized PDF onto Letter paper at scale 1, leaving only
// about 784 CSS pixels for content. Repeated page canvases authored for a
// desktop viewport can consequently reflow and spill onto a second PDF page.
// A 0.75 scale gives those canvases a roughly 1,045 CSS-pixel print viewport.
// Apply it only to repeated, explicitly paginated HTML without an authored
// paper size; ordinary flowing documents and @page-sized documents stay at 1.
const SCREEN_AUTHORED_PAGE_SCALE = 0.75;
// Keep headings with what follows, but not captions. A trailing caption's
// break-after can propagate to its figure/table and bind the whole container
// to unrelated following content. The container's break-inside keeps its
// caption with it, regardless of whether the caption is above or below.
const PAGINATION_CSS = `
  :where(table, thead, tfoot, tr, figure, blockquote, pre, details, .box, .card, [data-scient-pdf-keep-together]) {
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  :where(h1, h2, h3, h4, h5, h6) {
    break-after: avoid-page;
    page-break-after: avoid;
  }
  :where(p, li) {
    orphans: 3;
    widows: 3;
  }
`;

class BrowserPdfSurfaceChangedError extends Error {
  override readonly name = "BrowserPdfSurfaceChangedError";
}

class BrowserPdfOutputTooLargeError extends Error {
  override readonly name = "BrowserPdfOutputTooLargeError";
}

export interface BrowserPdfRendererError {
  readonly _tag: "BrowserPdfRendererError";
  readonly operation: string;
  readonly cause?: unknown;
}

export interface BrowserPdfRendererOptions {
  readonly waitForReadiness?: (webContents: WebContents) => Promise<BrowserPdfPageSignals>;
  readonly marginPolicy?: BrowserPdfMarginPolicy;
}

export type BrowserPdfMarginPolicy = "readable-fallback" | "source-authored";

export interface BrowserPdfPageSignals {
  readonly sourceUrl: string;
  readonly title: string;
  readonly sourceSignals: DesktopPreviewPdfExportArtifact["sourceSignals"];
  readonly warnings: ReadonlyArray<string>;
  readonly documentLayout?: BrowserPdfDocumentLayoutSignals;
}

interface BrowserPdfDocumentLayoutSignals {
  readonly hasAuthoredPageSize: boolean;
  readonly repeatedPageCanvases: boolean;
}

interface BrowserPdfReadinessResult {
  readonly settled: boolean;
  readonly sourceUrl: string;
  readonly title: string;
  readonly sourceSignals: DesktopPreviewPdfExportArtifact["sourceSignals"];
  readonly documentLayout?: BrowserPdfDocumentLayoutSignals;
}

const readinessScript = `
  (async () => {
    let active = true;
    let timeoutId;
    const imageCleanups = [];
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(false), ${READINESS_TIMEOUT_MS});
    });
    const settle = (async () => {
      try {
        if (document.fonts?.ready) await document.fonts.ready;
        if (!active) return false;
        const images = Array.from(document.images);
        await Promise.all(images.map((image) => {
          if (image.complete) return Promise.resolve();
          return new Promise((resolve) => {
            const finish = () => {
              image.removeEventListener("load", finish);
              image.removeEventListener("error", finish);
              resolve();
            };
            image.addEventListener("load", finish);
            image.addEventListener("error", finish);
            imageCleanups.push(() => {
              image.removeEventListener("load", finish);
              image.removeEventListener("error", finish);
            });
          });
        }));
      } catch {}
      if (!active) return false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })();
    const settled = await Promise.race([settle, timeout]);
    active = false;
    clearTimeout(timeoutId);
    for (const cleanup of imageCleanups) cleanup();
    const images = Array.from(document.images);
    const body = document.body;
    const explicitPageContainers = new Set();
    const pageCanvasSelectors = [];
    let hasAuthoredPageSize = false;
    let inspectedRuleCount = 0;
    const maxInspectedRules = 10_000;
    const hasPageCanvasSize = (style) => [
      "height",
      "min-height",
      "block-size",
      "min-block-size",
    ].some((property) => {
      const value = style?.getPropertyValue(property).trim().toLowerCase();
      return value && value !== "auto" && !/^0(?:[a-z%]+)?$/.test(value);
    });
    const visitRules = (rules) => {
      if (!rules || inspectedRuleCount >= maxInspectedRules) return;
      for (const rule of Array.from(rules)) {
        inspectedRuleCount += 1;
        if (inspectedRuleCount > maxInspectedRules) return;
        const style = rule.style;
        if (rule.constructor?.name === "CSSPageRule") {
          const pageSize = style?.getPropertyValue("size").trim();
          if (pageSize && pageSize !== "auto") hasAuthoredPageSize = true;
        }
        const breakAfter = style?.getPropertyValue("break-after").trim();
        const legacyBreakAfter = style?.getPropertyValue("page-break-after").trim();
        const selector = rule.selectorText;
        if (selector && hasPageCanvasSize(style)) pageCanvasSelectors.push(selector);
        if (
          explicitPageContainers.size < 2 &&
          (breakAfter === "page" || legacyBreakAfter === "always")
        ) {
          if (selector) {
            try {
              for (const element of document.querySelectorAll(selector)) {
                explicitPageContainers.add(element);
                if (explicitPageContainers.size >= 2) break;
              }
            } catch {}
          }
        }
        try {
          if (rule.cssRules) visitRules(rule.cssRules);
        } catch {}
      }
    };
    for (const sheet of [...Array.from(document.styleSheets), ...Array.from(document.adoptedStyleSheets || [])]) {
      try {
        visitRules(sheet.cssRules);
      } catch {}
    }
    for (const element of document.querySelectorAll("[style]")) {
      if (explicitPageContainers.size >= 2) break;
      const breakAfter = element.style.getPropertyValue("break-after").trim();
      const legacyBreakAfter = element.style.getPropertyValue("page-break-after").trim();
      if (breakAfter === "page" || legacyBreakAfter === "always") {
        explicitPageContainers.add(element);
      }
    }
    let sizedExplicitPageCount = 0;
    for (const element of explicitPageContainers) {
      let isPageCanvas = hasPageCanvasSize(element.style);
      if (!isPageCanvas) {
        for (const selector of pageCanvasSelectors) {
          try {
            if (element.matches(selector)) {
              isPageCanvas = true;
              break;
            }
          } catch {}
        }
      }
      if (isPageCanvas) sizedExplicitPageCount += 1;
    }
    return {
      settled: settled === true,
      sourceUrl: location.href,
      title: (document.title || location.hostname || "Document").slice(0, ${MAX_TITLE_LENGTH}),
      sourceSignals: {
        bodyTextLength: (body?.innerText || "").trim().length,
        imageCount: images.length,
        brokenImageCount: images.filter((image) => image.complete && image.naturalWidth === 0).length,
        canvasCount: document.querySelectorAll("canvas").length,
        videoCount: document.querySelectorAll("video").length,
        iframeCount: document.querySelectorAll("iframe").length,
        scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, body?.scrollWidth || 0),
        scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, body?.scrollHeight || 0),
      },
      documentLayout: {
        hasAuthoredPageSize,
        repeatedPageCanvases: sizedExplicitPageCount >= 2,
      },
    };
  })()
`;

function isReadinessResult(value: unknown): value is BrowserPdfReadinessResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const signals = candidate.sourceSignals;
  const documentLayout = candidate.documentLayout;
  if (typeof signals !== "object" || signals === null) return false;
  if (
    documentLayout !== undefined &&
    (typeof documentLayout !== "object" || documentLayout === null)
  ) {
    return false;
  }
  const numericKeys = [
    "bodyTextLength",
    "imageCount",
    "brokenImageCount",
    "canvasCount",
    "videoCount",
    "iframeCount",
    "scrollWidth",
    "scrollHeight",
  ] as const;
  return (
    typeof candidate.settled === "boolean" &&
    typeof candidate.sourceUrl === "string" &&
    typeof candidate.title === "string" &&
    (documentLayout === undefined ||
      (typeof (documentLayout as Record<string, unknown>).hasAuthoredPageSize === "boolean" &&
        typeof (documentLayout as Record<string, unknown>).repeatedPageCanvases === "boolean")) &&
    numericKeys.every((key) => {
      const number = (signals as Record<string, unknown>)[key];
      return typeof number === "number" && Number.isInteger(number) && number >= 0;
    })
  );
}

export function buildDocumentLayoutPrintOptions(
  scale = 1,
  marginPolicy: BrowserPdfMarginPolicy = "readable-fallback",
) {
  const margin = marginPolicy === "source-authored" ? 0 : READABLE_FALLBACK_MARGIN_INCHES;
  return {
    printBackground: true,
    displayHeaderFooter: false,
    margins: {
      top: margin,
      bottom: margin,
      left: margin,
      right: margin,
    },
    preferCSSPageSize: true,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
    scale,
  } as const;
}

function scaleForDocumentLayout(signals: BrowserPdfDocumentLayoutSignals | undefined): number {
  if (signals?.repeatedPageCanvases && !signals.hasAuthoredPageSize) {
    return SCREEN_AUTHORED_PAGE_SCALE;
  }
  return 1;
}

export function warningsForSignals(
  signals: DesktopPreviewPdfExportArtifact["sourceSignals"],
  readinessSettled: boolean,
): ReadonlyArray<string> {
  const warnings: string[] = [];
  if (!readinessSettled) warnings.push("readiness-timeout");
  if (signals.brokenImageCount > 0) warnings.push("missing-image-resources");
  if (signals.canvasCount > 0) warnings.push("canvas-content-flattened");
  if (signals.videoCount > 0) warnings.push("video-current-frame-only");
  if (signals.iframeCount > 0) warnings.push("embedded-frames-may-be-incomplete");
  if (signals.bodyTextLength === 0 && signals.imageCount === 0 && signals.canvasCount === 0) {
    warnings.push("low-content-signal");
  }
  return warnings;
}

export function createBrowserPdfRenderer(options: BrowserPdfRendererOptions) {
  const marginPolicy = options.marginPolicy ?? "readable-fallback";
  const waitForReadiness =
    options.waitForReadiness ??
    (async (webContents: WebContents): Promise<BrowserPdfPageSignals> => {
      const value = await webContents.executeJavaScript(readinessScript, true);
      if (!isReadinessResult(value)) {
        throw new Error("The browser page returned invalid export readiness signals.");
      }
      return {
        sourceUrl: value.sourceUrl,
        title: value.title,
        sourceSignals: value.sourceSignals,
        warnings: warningsForSignals(value.sourceSignals, value.settled),
        ...(value.documentLayout === undefined ? {} : { documentLayout: value.documentLayout }),
      };
    });

  return (
    webContents: WebContents,
  ): Effect.Effect<DesktopPreviewPdfExportArtifact, BrowserPdfRendererError> =>
    Effect.tryPromise({
      try: async () => {
        if (webContents.isDestroyed()) throw new Error("The preview page was closed.");
        if (webContents.isLoading()) {
          throw new BrowserPdfSurfaceChangedError(
            "Wait for the preview page to finish navigating before exporting it.",
          );
        }
        const initialUrl = webContents.getURL();
        let invalidatedReason: string | null = null;
        const invalidate = (reason: string) => {
          invalidatedReason ??= reason;
        };
        const onNavigation = (
          _event: Electron.Event,
          _url: string,
          _isInPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) invalidate("The preview page navigated during export.");
        };
        const onDestroyed = () => invalidate("The preview page was closed during export.");
        const onRenderProcessGone = () => invalidate("The preview renderer stopped during export.");
        let paginationCssKey: string | undefined;
        const assertStableSurface = (sourceUrl?: string) => {
          if (invalidatedReason !== null) {
            throw new BrowserPdfSurfaceChangedError(invalidatedReason);
          }
          if (webContents.isDestroyed()) {
            throw new BrowserPdfSurfaceChangedError("The preview page was closed during export.");
          }
          const currentUrl = webContents.getURL();
          if (currentUrl !== initialUrl || (sourceUrl !== undefined && sourceUrl !== initialUrl)) {
            throw new BrowserPdfSurfaceChangedError(
              "The preview page changed before the export completed.",
            );
          }
        };

        webContents.on("did-start-navigation", onNavigation);
        webContents.on("destroyed", onDestroyed);
        webContents.on("render-process-gone", onRenderProcessGone);
        try {
          paginationCssKey = await webContents.insertCSS(PAGINATION_CSS, {
            cssOrigin: "author",
          });
          const page = await waitForReadiness(webContents);
          assertStableSurface(page.sourceUrl);
          const data = await webContents.printToPDF(
            buildDocumentLayoutPrintOptions(
              scaleForDocumentLayout(page.documentLayout),
              marginPolicy,
            ),
          );
          // Chromium cannot cancel an in-flight print safely. Wait for it to
          // settle under the global print permit, then discard raced output.
          assertStableSurface(page.sourceUrl);
          if (data.byteLength === 0) throw new Error("Chromium returned an empty PDF.");
          if (data.byteLength > BROWSER_PDF_EXPORT_MAX_BYTES) {
            throw new BrowserPdfOutputTooLargeError(
              "The generated PDF exceeds the current 64 MiB HTML export limit.",
            );
          }
          return {
            data: new Uint8Array(data),
            sourceUrl: page.sourceUrl,
            title: page.title,
            profile: "document-layout" as const,
            media: "print" as const,
            warnings: page.warnings,
            sourceSignals: page.sourceSignals,
          } satisfies DesktopPreviewPdfExportArtifact;
        } finally {
          if (paginationCssKey !== undefined && !webContents.isDestroyed()) {
            await webContents.removeInsertedCSS(paginationCssKey).catch(() => undefined);
          }
          webContents.off("did-start-navigation", onNavigation);
          webContents.off("destroyed", onDestroyed);
          webContents.off("render-process-gone", onRenderProcessGone);
        }
      },
      catch: (cause) => ({
        _tag: "BrowserPdfRendererError" as const,
        operation:
          cause instanceof BrowserPdfSurfaceChangedError
            ? "exportPdf.surfaceChanged"
            : cause instanceof BrowserPdfOutputTooLargeError
              ? "exportPdf.tooLarge"
              : "printToPDF",
        cause,
      }),
    });
}
