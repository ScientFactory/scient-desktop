import type { DesktopPreviewPdfExportArtifact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { WebContents } from "electron";

const READINESS_TIMEOUT_MS = 2_500;
const MAX_TITLE_LENGTH = 512;
const PAGINATION_CSS = `
  :where(table, thead, tfoot, tr, figure, blockquote, pre, details, .box, .card, [data-scient-pdf-keep-together]) {
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  :where(h1, h2, h3, h4, h5, h6, caption, figcaption) {
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

export interface BrowserPdfRendererError {
  readonly _tag: "BrowserPdfRendererError";
  readonly operation: string;
  readonly cause?: unknown;
}

export interface BrowserPdfRendererOptions {
  readonly waitForReadiness?: (webContents: WebContents) => Promise<BrowserPdfPageSignals>;
}

export interface BrowserPdfPageSignals {
  readonly sourceUrl: string;
  readonly title: string;
  readonly sourceSignals: DesktopPreviewPdfExportArtifact["sourceSignals"];
  readonly warnings: ReadonlyArray<string>;
}

const readinessScript = `
  (async () => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), ${READINESS_TIMEOUT_MS}));
    const settle = (async () => {
      try {
        if (document.fonts?.ready) await document.fonts.ready;
        const images = Array.from(document.images);
        await Promise.all(images.map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
      } catch {}
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })();
    const settled = await Promise.race([settle, timeout]);
    const images = Array.from(document.images);
    const body = document.body;
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
    };
  })()
`;

function isSignals(value: unknown): value is BrowserPdfPageSignals {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const signals = candidate.sourceSignals;
  if (typeof signals !== "object" || signals === null) return false;
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
    typeof candidate.sourceUrl === "string" &&
    typeof candidate.title === "string" &&
    numericKeys.every((key) => {
      const number = (signals as Record<string, unknown>)[key];
      return typeof number === "number" && Number.isInteger(number) && number >= 0;
    })
  );
}

export function buildDocumentLayoutPrintOptions() {
  return {
    printBackground: true,
    displayHeaderFooter: false,
    margins: {
      marginType: "custom",
      top: 16,
      bottom: 16,
      left: 16,
      right: 16,
    },
    preferCSSPageSize: true,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
    scale: 1,
  } as const;
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
  const waitForReadiness =
    options.waitForReadiness ??
    (async (webContents: WebContents): Promise<BrowserPdfPageSignals> => {
      const value = await webContents.executeJavaScript(readinessScript, true);
      if (!isSignals(value)) {
        throw new Error("The browser page returned invalid export readiness signals.");
      }
      const settled =
        typeof value === "object" && value !== null && "settled" in value
          ? (value as { settled?: unknown }).settled === true
          : false;
      return {
        sourceUrl: value.sourceUrl,
        title: value.title,
        sourceSignals: value.sourceSignals,
        warnings: warningsForSignals(value.sourceSignals, settled),
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
          const data = await webContents.printToPDF(buildDocumentLayoutPrintOptions());
          // Chromium cannot cancel an in-flight print safely. Wait for it to
          // settle under the global print permit, then discard raced output.
          assertStableSurface(page.sourceUrl);
          if (data.byteLength === 0) throw new Error("Chromium returned an empty PDF.");
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
            : "printToPDF",
        cause,
      }),
    });
}
