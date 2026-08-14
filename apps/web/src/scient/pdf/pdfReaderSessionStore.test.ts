import type { StateStorage } from "~/lib/storage";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPdfReaderSessionStore,
  decodePdfReaderSessions,
  PDF_READER_SESSION_STORAGE_KEY,
  pdfReaderSessionDocumentKey,
  pdfReaderViewportFromLocation,
  registerPdfReaderSessionTeardownFlush,
  restorePdfReaderViewport,
  type PdfReaderViewport,
} from "./pdfReaderSessionStore";
import { createPdfReaderViewportSession } from "./pdfReaderViewportSession";

const VIEWPORT: PdfReaderViewport = {
  page: 7,
  left: 42,
  top: 731,
  scaleValue: "1.25",
  rotation: 90,
};

function createMockStorage(initialValue?: string) {
  const values = new Map<string, string>();
  if (initialValue !== undefined) values.set(PDF_READER_SESSION_STORAGE_KEY, initialValue);
  const storage: StateStorage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
    }),
  };
  return {
    storage,
    read: () => values.get(PDF_READER_SESSION_STORAGE_KEY) ?? null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PDF reader session persistence", () => {
  it("keys state by stable document identity rather than a renewable source URL", () => {
    expect(
      pdfReaderSessionDocumentKey({
        authority: "environment-1",
        logicalDocumentKey: "workspace:thread:/papers/results.pdf",
      }),
    ).toBe('["environment-1","workspace:thread:/papers/results.pdf"]');
    expect(
      pdfReaderSessionDocumentKey({ authority: "environment-2", logicalDocumentKey: "paper" }),
    ).not.toBe(
      pdfReaderSessionDocumentKey({ authority: "environment-1", logicalDocumentKey: "paper" }),
    );
  });

  it("round-trips independent viewport and sidebar state by logical document", () => {
    const persisted = createMockStorage();
    const first = createPdfReaderSessionStore({
      storage: persisted.storage,
      writeDelayMs: 0,
      now: () => 1_000,
    });

    first.updateViewport("project-a:paper", VIEWPORT);
    first.updateSidebar("project-a:paper", "outline");
    first.updateSidebar("project-b:appendix", "thumbnails");
    first.flush();

    const restored = createPdfReaderSessionStore({
      storage: persisted.storage,
      writeDelayMs: 0,
    });
    expect(restored.get("project-a:paper")).toMatchObject({
      viewport: VIEWPORT,
      sidebar: "outline",
    });
    expect(restored.get("project-b:appendix")).toMatchObject({
      viewport: null,
      sidebar: "thumbnails",
    });
    expect(restored.get("project-c:unopened")).toEqual({
      viewport: null,
      sidebar: "closed",
      updatedAt: 0,
    });
  });

  it("ignores corrupt envelopes and invalid entries without losing valid sessions", () => {
    expect(decodePdfReaderSessions("not-json")).toEqual({});
    expect(decodePdfReaderSessions(JSON.stringify({ version: 2, sessions: {} }))).toEqual({});

    const sessions = decodePdfReaderSessions(
      JSON.stringify({
        version: 1,
        sessions: {
          valid: { viewport: VIEWPORT, sidebar: "outline", updatedAt: 9 },
          "bad-viewport": {
            viewport: { ...VIEWPORT, top: Number.MAX_VALUE },
            sidebar: "closed",
            updatedAt: 8,
          },
          "bad-sidebar": { viewport: null, sidebar: "files", updatedAt: 7 },
          "bad-timestamp": { viewport: null, sidebar: "closed", updatedAt: -1 },
        },
      }),
    );

    expect(sessions).toEqual({
      valid: { viewport: VIEWPORT, sidebar: "outline", updatedAt: 9 },
    });
  });

  it("keeps only the most recently used bounded set of documents", () => {
    const persisted = createMockStorage();
    const store = createPdfReaderSessionStore({
      storage: persisted.storage,
      maxDocuments: 2,
      writeDelayMs: 0,
      now: () => 100,
    });

    store.updateSidebar("paper-a", "outline");
    store.updateSidebar("paper-b", "outline");
    store.updateViewport("paper-a", VIEWPORT);
    store.updateSidebar("paper-c", "thumbnails");

    expect(store.get("paper-a").viewport).toEqual(VIEWPORT);
    expect(store.get("paper-b").updatedAt).toBe(0);
    expect(store.get("paper-c").sidebar).toBe("thumbnails");
    expect(Object.keys(decodePdfReaderSessions(persisted.read(), 2)).sort()).toEqual([
      "paper-a",
      "paper-c",
    ]);
  });

  it("coalesces rapid viewport events and flushes pending state exactly once", () => {
    vi.useFakeTimers();
    const persisted = createMockStorage();
    const store = createPdfReaderSessionStore({
      storage: persisted.storage,
      writeDelayMs: 250,
    });

    store.updateViewport("paper", VIEWPORT);
    store.updateViewport("paper", { ...VIEWPORT, top: 700 });
    expect(persisted.storage.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(persisted.storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persisted.storage.setItem).toHaveBeenCalledTimes(1);

    store.flush();
    expect(persisted.storage.setItem).toHaveBeenCalledTimes(1);

    store.updateSidebar("paper", "outline");
    store.flush();
    vi.advanceTimersByTime(250);
    expect(persisted.storage.setItem).toHaveBeenCalledTimes(2);
    expect(decodePdfReaderSessions(persisted.read()).paper?.sidebar).toBe("outline");
  });

  it("flushes pending state on page teardown and store disposal", () => {
    vi.useFakeTimers();
    const persisted = createMockStorage();
    const store = createPdfReaderSessionStore({
      storage: persisted.storage,
      writeDelayMs: 250,
    });
    const listeners = new Map<string, () => void>();
    registerPdfReaderSessionTeardownFlush(
      (event, listener) => listeners.set(event, listener),
      store,
    );

    store.updateViewport("paper", VIEWPORT);
    listeners.get("pagehide")?.();
    expect(persisted.storage.setItem).toHaveBeenCalledTimes(1);

    store.updateSidebar("paper", "outline");
    listeners.get("beforeunload")?.();
    expect(persisted.storage.setItem).toHaveBeenCalledTimes(2);

    store.updateSidebar("paper", "thumbnails");
    store.dispose();
    vi.advanceTimersByTime(250);
    expect(persisted.storage.setItem).toHaveBeenCalledTimes(3);
    expect(decodePdfReaderSessions(persisted.read()).paper?.sidebar).toBe("thumbnails");
  });

  it("continues in memory and reports a storage write failure only once", () => {
    const error = new Error("storage unavailable");
    const onStorageError = vi.fn();
    const storage: StateStorage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw error;
      }),
      removeItem: vi.fn(),
    };
    const store = createPdfReaderSessionStore({ storage, writeDelayMs: 0, onStorageError });

    expect(() => store.updateViewport("paper", VIEWPORT)).not.toThrow();
    expect(() => store.updateSidebar("paper", "outline")).not.toThrow();

    expect(store.get("paper")).toMatchObject({ viewport: VIEWPORT, sidebar: "outline" });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(onStorageError).toHaveBeenCalledOnce();
    expect(onStorageError).toHaveBeenCalledWith(error);
  });

  it("continues in memory when persisted state cannot be read", () => {
    const error = new Error("storage read blocked");
    const onStorageError = vi.fn();
    const storage: StateStorage = {
      getItem: vi.fn(() => {
        throw error;
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const store = createPdfReaderSessionStore({ storage, writeDelayMs: 0, onStorageError });

    store.updateSidebar("paper", "thumbnails");

    expect(store.get("paper").sidebar).toBe("thumbnails");
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(onStorageError).toHaveBeenCalledOnce();
    expect(onStorageError).toHaveBeenCalledWith(error);
  });
});

describe("PDF reader viewport lifecycle", () => {
  it("preserves the saved view through initial layout, renewal, and remount", () => {
    const documentKey = "environment:logical-paper";
    const persisted = createMockStorage();
    const firstStore = createPdfReaderSessionStore({
      storage: persisted.storage,
      writeDelayMs: 250,
    });
    firstStore.updateViewport(documentKey, VIEWPORT);
    firstStore.flush();

    const session = createPdfReaderViewportSession({ documentKey, store: firstStore });
    const firstTarget = {
      currentPageNumber: 1,
      currentScale: 1,
      currentScaleValue: "auto",
      pagesRotation: 0,
      scrollPageIntoView: vi.fn(),
    };
    const transientDefaultLocation = {
      pageNumber: 1,
      left: 0,
      top: 792,
      scale: 100,
      rotation: 0,
    };

    session.updateFromViewArea(transientDefaultLocation);
    expect(session.restore(firstTarget, 20)).toBe(7);
    session.updateFromViewArea(transientDefaultLocation);
    session.snapshot(firstTarget, 20);
    expect(firstStore.get(documentKey).viewport).toEqual(VIEWPORT);

    session.completeRestore();
    session.updateFromViewArea({
      pageNumber: 9,
      left: 17,
      top: 640,
      scale: 150,
      rotation: 180,
    });
    session.snapshot(
      {
        currentPageNumber: 9,
        currentScale: 1.5,
        currentScaleValue: "1.5",
        pagesRotation: 180,
      },
      20,
    );
    session.flush();

    const remountedStore = createPdfReaderSessionStore({
      storage: persisted.storage,
      writeDelayMs: 250,
    });
    const remountedSession = createPdfReaderViewportSession({
      documentKey,
      store: remountedStore,
    });
    const renewedUrlTarget = {
      currentPageNumber: 1,
      currentScale: 1,
      currentScaleValue: "auto",
      pagesRotation: 0,
      scrollPageIntoView: vi.fn(),
    };

    expect(remountedSession.restore(renewedUrlTarget, 20)).toBe(9);
    expect(renewedUrlTarget.pagesRotation).toBe(180);
    expect(renewedUrlTarget.currentScaleValue).toBe("1.5");
    expect(renewedUrlTarget.scrollPageIntoView).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumber: 9,
        destArray: [null, { name: "XYZ" }, 17, 640, null],
      }),
    );
  });
});

describe("PDF.js viewport translation", () => {
  it("converts PDF.js percentage zoom while preserving named zoom modes", () => {
    expect(
      pdfReaderViewportFromLocation({
        pageNumber: 7,
        left: 42,
        top: 731,
        scale: 125,
        rotation: 90,
      }),
    ).toEqual(VIEWPORT);
    expect(
      pdfReaderViewportFromLocation({
        pageNumber: 2,
        left: 0,
        top: 900,
        scale: "page-width",
        rotation: 0,
      }),
    ).toEqual({ page: 2, left: 0, top: 900, scaleValue: "page-width", rotation: 0 });
    expect(
      pdfReaderViewportFromLocation({
        pageNumber: 3,
        left: 0,
        top: 800,
        scale: "page-height",
        rotation: 0,
      }),
    ).toEqual({ page: 3, left: 0, top: 800, scaleValue: "page-height", rotation: 0 });
    expect(
      pdfReaderViewportFromLocation({
        pageNumber: 2,
        left: 0,
        top: 900,
        scale: 0,
        rotation: 0,
      }),
    ).toBeNull();
  });

  it("restores rotation, scale, page, and PDF coordinates in a single destination", () => {
    const target = {
      currentPageNumber: 1,
      currentScaleValue: "auto",
      pagesRotation: 0,
      scrollPageIntoView: vi.fn(),
    };

    expect(restorePdfReaderViewport(target, VIEWPORT, 5)).toBe(5);
    expect(target.pagesRotation).toBe(90);
    expect(target.currentScaleValue).toBe("1.25");
    expect(target.scrollPageIntoView).toHaveBeenCalledWith({
      pageNumber: 5,
      destArray: [null, { name: "XYZ" }, 42, 731, null],
      allowNegativeOffset: true,
      ignoreDestinationZoom: true,
    });
  });

  it("uses fit-width for a document without saved state", () => {
    const target = {
      currentPageNumber: 1,
      currentScaleValue: "auto",
      pagesRotation: 0,
      scrollPageIntoView: vi.fn(),
    };

    expect(restorePdfReaderViewport(target, null, 20)).toBe(1);
    expect(target.currentScaleValue).toBe("page-width");
    expect(target.scrollPageIntoView).not.toHaveBeenCalled();
  });

  it("uses PDF.js top-of-page defaults when only coarse page state was available", () => {
    const target = {
      currentPageNumber: 1,
      currentScaleValue: "auto",
      pagesRotation: 0,
      scrollPageIntoView: vi.fn(),
    };

    restorePdfReaderViewport(target, { ...VIEWPORT, left: null, top: null }, 20);

    expect(target.scrollPageIntoView).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumber: 7,
        destArray: [null, { name: "XYZ" }, null, null, null],
      }),
    );
  });
});
