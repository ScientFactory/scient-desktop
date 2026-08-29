import { describe, it } from "@effect/vitest";
import { BROWSER_PDF_EXPORT_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, vi } from "vite-plus/test";

import {
  buildDocumentLayoutPrintOptions,
  createBrowserPdfRenderer,
  warningsForSignals,
} from "./BrowserPdfRenderer.ts";

const signals = {
  bodyTextLength: 120,
  imageCount: 2,
  brokenImageCount: 0,
  canvasCount: 0,
  videoCount: 0,
  iframeCount: 0,
  scrollWidth: 900,
  scrollHeight: 2_400,
} as const;

describe("BrowserPdfRenderer", () => {
  it.effect("adds reversible pagination defaults to a semantic document-layout export", () =>
    Effect.gen(function* () {
      let printedOptions: unknown;
      let printCount = 0;
      const listeners = new Map<string, Set<(...args: never[]) => void>>();
      const insertCSS = vi.fn(
        async (_css: string, _options: { readonly cssOrigin: "author" }) => "pagination-css",
      );
      const removeInsertedCSS = vi.fn(async () => undefined);
      const webContents = {
        isDestroyed: () => false,
        isLoading: () => false,
        getURL: () => "https://example.test/report.html",
        on: (event: string, listener: (...args: never[]) => void) => {
          const current = listeners.get(event) ?? new Set();
          current.add(listener);
          listeners.set(event, current);
        },
        off: (event: string, listener: (...args: never[]) => void) => {
          listeners.get(event)?.delete(listener);
        },
        insertCSS,
        removeInsertedCSS,
        printToPDF: async (options: unknown) => {
          printedOptions = options;
          printCount += 1;
          return Buffer.from("%PDF-1.7\nsynthetic");
        },
      };
      const render = createBrowserPdfRenderer({
        waitForReadiness: async () => ({
          sourceUrl: "https://example.test/report.html",
          title: "Report",
          sourceSignals: signals,
          warnings: [],
        }),
      });

      const result = yield* render(webContents as never);

      expect(printCount).toBe(1);
      expect(insertCSS).toHaveBeenCalledWith(expect.stringContaining("break-inside: avoid-page"), {
        cssOrigin: "author",
      });
      const paginationCss = insertCSS.mock.calls[0]?.[0] ?? "";
      expect(paginationCss).toContain(".box");
      expect(paginationCss).toContain(".card");
      expect(paginationCss).toContain("break-after: avoid-page");
      expect(paginationCss).toContain("orphans: 3");
      expect(paginationCss).toContain("widows: 3");
      expect(paginationCss).not.toMatch(/direction|unicode-bidi|font|display|color|content\s*:/);
      expect(removeInsertedCSS).toHaveBeenCalledWith("pagination-css");
      expect(printedOptions).toEqual({
        printBackground: true,
        displayHeaderFooter: false,
        margins: {
          top: 1 / 6,
          bottom: 1 / 6,
          left: 1 / 6,
          right: 1 / 6,
        },
        preferCSSPageSize: true,
        generateTaggedPDF: true,
        generateDocumentOutline: true,
        scale: 1,
      });
      expect(result.data).toEqual(new Uint8Array(Buffer.from("%PDF-1.7\nsynthetic")));
      expect(result.profile).toBe("document-layout");
      expect(result.media).toBe("print");
      expect(result.sourceSignals).toEqual(signals);
      expect([...listeners.values()].every((registered) => registered.size === 0)).toBe(true);
    }),
  );

  it("lets controlled document builds use only source-authored page margins", () => {
    expect(buildDocumentLayoutPrintOptions(1, "source-authored")).toMatchObject({
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    expect(buildDocumentLayoutPrintOptions()).toMatchObject({
      margins: {
        top: 1 / 6,
        bottom: 1 / 6,
        left: 1 / 6,
        right: 1 / 6,
      },
    });
  });

  it.effect("forwards the controlled-build margin policy to Chromium", () =>
    Effect.gen(function* () {
      const printToPDF = vi.fn(async () => Buffer.from("%PDF-1.7\nsynthetic"));
      const webContents = {
        isDestroyed: () => false,
        isLoading: () => false,
        getURL: () => "https://example.test/report.html",
        on: vi.fn(),
        off: vi.fn(),
        insertCSS: vi.fn(async () => "pagination-css"),
        removeInsertedCSS: vi.fn(async () => undefined),
        printToPDF,
      };
      const render = createBrowserPdfRenderer({
        marginPolicy: "source-authored",
        waitForReadiness: async () => ({
          sourceUrl: "https://example.test/report.html",
          title: "Report",
          sourceSignals: signals,
          warnings: [],
        }),
      });

      yield* render(webContents as never);

      expect(printToPDF).toHaveBeenCalledWith(
        expect.objectContaining({
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        }),
      );
    }),
  );

  it("reports lossy or incomplete source signals without rejecting the export", () => {
    expect(
      warningsForSignals(
        {
          ...signals,
          brokenImageCount: 1,
          canvasCount: 2,
          videoCount: 1,
          iframeCount: 1,
        },
        false,
      ),
    ).toEqual([
      "readiness-timeout",
      "missing-image-resources",
      "canvas-content-flattened",
      "video-current-frame-only",
      "embedded-frames-may-be-incomplete",
    ]);
  });

  it.effect("fits only repeated screen-authored page sets to the paper viewport", () =>
    Effect.gen(function* () {
      const printedScales: number[] = [];
      const webContents = {
        isDestroyed: () => false,
        isLoading: () => false,
        getURL: () => "https://example.test/report.html",
        on: vi.fn(),
        off: vi.fn(),
        insertCSS: vi.fn(async () => "pagination-css"),
        removeInsertedCSS: vi.fn(async () => undefined),
        printToPDF: vi.fn(async (options: { readonly scale: number }) => {
          printedScales.push(options.scale);
          return Buffer.from("%PDF-1.7\nsynthetic");
        }),
      };
      const layouts = [
        { repeatedPageCanvases: true, hasAuthoredPageSize: false },
        { repeatedPageCanvases: true, hasAuthoredPageSize: true },
        { repeatedPageCanvases: false, hasAuthoredPageSize: false },
      ] as const;

      for (const documentLayout of layouts) {
        const render = createBrowserPdfRenderer({
          waitForReadiness: async () => ({
            sourceUrl: "https://example.test/report.html",
            title: "Report",
            sourceSignals: signals,
            warnings: [],
            documentLayout,
          }),
        });
        yield* render(webContents as never);
      }

      expect(printedScales).toEqual([0.75, 1, 1]);
    }),
  );

  it.effect("does not call print when the guest is already destroyed", () =>
    Effect.gen(function* () {
      const render = createBrowserPdfRenderer({
        waitForReadiness: async () => {
          throw new Error("readiness should not run");
        },
      });
      const exit = yield* Effect.exit(render({ isDestroyed: () => true } as never));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("rejects oversized output before it crosses the desktop IPC boundary", () =>
    Effect.gen(function* () {
      const webContents = {
        isDestroyed: () => false,
        isLoading: () => false,
        getURL: () => "https://example.test/report.html",
        on: vi.fn(),
        off: vi.fn(),
        insertCSS: vi.fn(async () => "pagination-css"),
        removeInsertedCSS: vi.fn(async () => undefined),
        printToPDF: vi.fn(async () => ({ byteLength: BROWSER_PDF_EXPORT_MAX_BYTES + 1 })),
      };
      const render = createBrowserPdfRenderer({
        waitForReadiness: async () => ({
          sourceUrl: "https://example.test/report.html",
          title: "Report",
          sourceSignals: signals,
          warnings: [],
        }),
      });

      const exit = yield* Effect.exit(render(webContents as never));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("exportPdf.tooLarge");
      }
      expect(webContents.removeInsertedCSS).toHaveBeenCalledWith("pagination-css");
    }),
  );

  it.effect("cleans up readiness listeners when bounded preparation stops waiting", () =>
    Effect.gen(function* () {
      let readinessSource = "";
      const webContents = {
        isDestroyed: () => false,
        isLoading: () => false,
        getURL: () => "https://example.test/report.html",
        on: vi.fn(),
        off: vi.fn(),
        insertCSS: vi.fn(async () => "pagination-css"),
        removeInsertedCSS: vi.fn(async () => undefined),
        executeJavaScript: vi.fn(async (source: string) => {
          readinessSource = source;
          return {
            settled: true,
            sourceUrl: "https://example.test/report.html",
            title: "Report",
            sourceSignals: signals,
            documentLayout: {
              hasAuthoredPageSize: false,
              repeatedPageCanvases: true,
            },
          };
        }),
        printToPDF: vi.fn(async () => Buffer.from("%PDF-1.7\nsynthetic")),
      };
      const render = createBrowserPdfRenderer({});

      yield* render(webContents as never);

      expect(readinessSource).toContain('image.removeEventListener("load", finish)');
      expect(readinessSource).toContain('image.removeEventListener("error", finish)');
      expect(readinessSource).toContain("active = false");
      expect(readinessSource).toContain("clearTimeout(timeoutId)");
      expect(readinessSource).toContain('rule.constructor?.name === "CSSPageRule"');
      expect(readinessSource).toContain('getPropertyValue("break-after")');
      expect(readinessSource).toContain("document.adoptedStyleSheets");
      expect(webContents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({ scale: 0.75 }));
    }),
  );

  it.effect("discards output if the main frame navigates during Chromium printing", () =>
    Effect.gen(function* () {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      let printStarted = false;
      let finishPrint: (value: Buffer) => void = () => {
        throw new Error("print did not start");
      };
      const printPromise = new Promise<Buffer>((resolve) => {
        finishPrint = resolve;
      });
      const removeInsertedCSS = vi.fn(async () => undefined);
      const webContents = {
        isDestroyed: () => false,
        isLoading: () => false,
        getURL: () => "https://example.test/report.html",
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const current = listeners.get(event) ?? new Set();
          current.add(listener);
          listeners.set(event, current);
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(listener);
        },
        insertCSS: async () => "pagination-css",
        removeInsertedCSS,
        printToPDF: () => {
          printStarted = true;
          return printPromise;
        },
      };
      const render = createBrowserPdfRenderer({
        waitForReadiness: async () => ({
          sourceUrl: "https://example.test/report.html",
          title: "Report",
          sourceSignals: signals,
          warnings: [],
        }),
      });

      const fiber = yield* Effect.forkChild(render(webContents as never), {
        startImmediately: true,
      });
      yield* Effect.promise(() => vi.waitFor(() => expect(printStarted).toBe(true)));
      for (const listener of listeners.get("did-start-navigation") ?? []) {
        listener({} as Electron.Event, "https://example.test/other.html", false, true);
      }
      finishPrint(Buffer.from("%PDF-1.7\nwrong-page"));

      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("exportPdf.surfaceChanged");
      }
      expect(removeInsertedCSS).toHaveBeenCalledWith("pagination-css");
      expect([...listeners.values()].every((registered) => registered.size === 0)).toBe(true);
    }),
  );
});
