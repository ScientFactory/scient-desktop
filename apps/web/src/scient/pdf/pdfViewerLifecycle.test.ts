import * as NodeTimers from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vite-plus/test";
import {
  AnnotationEditorType,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

// These doubles implement DOM bookkeeping only. PDFViewer, PDFPageView, their
// promise continuations, and the rendering queue all come from the installed engine.
class TestDiv extends EventTarget {
  readonly tagName = "DIV";
  readonly offsetParent = null;
  readonly clientHeight = 0;
  readonly clientWidth = 0;
  readonly clientTop = 0;
  readonly clientLeft = 0;
  readonly offsetTop = 0;
  readonly offsetLeft = 0;
  scrollTop = 0;
  scrollLeft = 0;
  lang = "";
  className = "";
  parentNode: TestDiv | null = null;
  childNodes: TestDiv[] = [];
  private readonly attributes = new Map<string, string>();
  readonly style = {
    width: "",
    setProperty(_name: string, _value: unknown) {},
    removeProperty(_name: string) {},
  };
  readonly classList = {
    add(..._names: string[]) {},
    remove(..._names: string[]) {},
    toggle(_name: string, _force?: boolean) {},
    contains(_name: string) {
      return false;
    },
  };

  set textContent(_text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }

  append(child: TestDiv) {
    child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
    this.parentNode = null;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "lang") this.lang = "";
  }
}

class TestDocument extends EventTarget {
  readonly documentElement = new TestDiv();
  // Exercise PDF.js's real force-fetch path, without canvas or browser layout.
  readonly visibilityState = "hidden";

  createElement(tag: string) {
    if (tag !== "div") throw new Error(`Unexpected element in lifecycle test: ${tag}`);
    return new TestDiv();
  }
}

type Metadata = Awaited<ReturnType<PDFDocumentProxy["getMetadata"]>>;
type OptionalContent = Awaited<ReturnType<PDFDocumentProxy["getOptionalContentConfig"]>>;
type PDFViewerOptions = ConstructorParameters<typeof PDFViewer>[0];
type StartupRequest = "first-page" | "permissions" | "optional-content";
type Transition = "detach" | "replace" | "same-document-rebind";
interface TestViewport {
  readonly scale: number;
  readonly rotation: number;
  readonly userUnit: number;
  readonly width: number;
  readonly height: number;
  readonly clone: () => TestViewport;
}
const transitions: Transition[] = ["detach", "replace", "same-document-rebind"];
const startupRequests: StartupRequest[] = ["first-page", "permissions", "optional-content"];

function metadata(language: string): Metadata {
  // The implementation returns null for absent XMP; its declaration omits null.
  return { info: { Language: language }, metadata: null } as unknown as Metadata;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function page(pageNumber: number): PDFPageProxy {
  const viewport = (scale: number, rotation = 0): TestViewport => ({
    scale,
    rotation,
    userUnit: 1,
    width: 600 * scale,
    height: 800 * scale,
    clone: () => viewport(scale, rotation),
  });
  return {
    pageNumber,
    rotate: 0,
    getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) =>
      viewport(scale, rotation),
    cleanup: vi.fn(),
  } as unknown as PDFPageProxy;
}

function createRequests(pageCount: number) {
  const pages = Array.from({ length: pageCount }, () => deferred<PDFPageProxy>());
  const permissions = deferred<number[] | null>();
  const optionalContent = deferred<OptionalContent>();
  const metadataRequest = deferred<Metadata>();
  const requestedPages: number[] = [];

  const startup = (except?: StartupRequest) => {
    if (except !== "first-page") pages[0]!.resolve(page(1));
    // setDocument resets the editor mode on rebind. Restricted fixture
    // permissions keep editor UI out of this non-rendering harness each time.
    if (except !== "permissions") permissions.resolve([]);
    if (except !== "optional-content") {
      optionalContent.resolve({ hasInitialVisibility: true } as OptionalContent);
    }
  };
  const fail = (request: StartupRequest, reason: Error) => {
    if (request === "first-page") pages[0]!.reject(reason);
    else if (request === "permissions") permissions.reject(reason);
    else optionalContent.reject(reason);
  };
  return { pages, permissions, optionalContent, metadataRequest, requestedPages, startup, fail };
}

function createDocument(pageCount = 1) {
  let requests = createRequests(pageCount);
  const proxy = {
    numPages: pageCount,
    loadingParams: { disableAutoFetch: false },
    getPage: vi.fn((pageNumber: number) => {
      requests.requestedPages.push(pageNumber);
      const request = requests.pages[pageNumber - 1];
      if (!request) throw new Error(`Unexpected page request: ${pageNumber}`);
      return request.promise;
    }),
    getPermissions: () => requests.permissions.promise,
    getOptionalContentConfig: () => requests.optionalContent.promise,
    getMetadata: vi.fn(() => requests.metadataRequest.promise),
  };
  return {
    document: proxy as unknown as PDFDocumentProxy,
    proxy,
    get requests() {
      return requests;
    },
    rebind() {
      requests = createRequests(pageCount);
    },
  };
}

let engine: typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
let errors: MockInstance<typeof console.error>;
const viewers: Array<{ viewer: PDFViewer; lifetime: AbortController }> = [];

// Advancing one event-loop turn drains promise continuations and gives the test
// runner its normal opportunity to fail on unhandled rejections. No sleeps,
// fake timers, or process-level rejection handlers hide a failure.
const drain = () => new Promise<void>((resolve) => NodeTimers.setImmediate(resolve));

function attach(viewer: PDFViewer, document: PDFDocumentProxy | null) {
  // The installed implementation accepts null, but its declarations omit it.
  (viewer.setDocument as (document: PDFDocumentProxy | null) => void).call(viewer, document);
}

function observePages(viewer: PDFViewer) {
  // The public getter returns null after detach. Inspect the reset capability
  // as well, to catch the original bug rejecting this otherwise orphaned promise.
  const { promise } = viewer._pagesCapability as { promise: Promise<void> };
  const resolved = vi.fn();
  const rejected = vi.fn();
  void promise.then(resolved, rejected);
  return { promise, resolved, rejected };
}

function expectPending(observation: ReturnType<typeof observePages>) {
  expect(observation.resolved).not.toHaveBeenCalled();
  expect(observation.rejected).not.toHaveBeenCalled();
}

function createViewer() {
  const element = new TestDiv();
  const container = new TestDiv();
  container.append(element);
  const eventBus = new engine.EventBus();
  const lifetime = new AbortController();
  const options = {
    container: container as unknown as HTMLDivElement,
    viewer: element as unknown as HTMLDivElement,
    eventBus,
    l10n: {} as NonNullable<PDFViewerOptions["l10n"]>,
    annotationEditorMode: AnnotationEditorType.DISABLE,
    textLayerMode: 0,
    enableSelectionRendering: false,
    enablePermissions: true,
    abortSignal: lifetime.signal,
  };
  const viewer = new engine.PDFViewer(options);
  viewers.push({ viewer, lifetime });
  const pagesInit = vi.fn();
  const pagesLoaded = vi.fn();
  eventBus.on("pagesinit", pagesInit);
  eventBus.on("pagesloaded", pagesLoaded);
  return { viewer, element, pagesInit, pagesLoaded };
}

function transition(
  viewer: PDFViewer,
  previous: ReturnType<typeof createDocument>,
  kind: Transition,
) {
  if (kind === "detach") {
    attach(viewer, null);
    return null;
  }
  const next = kind === "replace" ? createDocument(previous.document.numPages) : previous;
  if (kind === "same-document-rebind") next.rebind();
  attach(viewer, next.document);
  return next;
}

beforeEach(async () => {
  vi.stubGlobal("document", new TestDocument());
  vi.stubGlobal("window", { cancelAnimationFrame: vi.fn(), requestAnimationFrame: vi.fn() });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Import the real viewer after installing the DOM. The static core import
  // above initializes the pdfjsLib global consumed by this distribution.
  engine ??= await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
  errors = vi.spyOn(console, "error");
});

afterEach(async () => {
  try {
    for (const { viewer, lifetime } of viewers.splice(0)) {
      attach(viewer, null);
      lifetime.abort();
    }
    await drain();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("installed PDFViewer startup ownership", () => {
  for (const kind of transitions) {
    for (const request of startupRequests) {
      it(`ignores late ${request} failure after ${kind}`, async () => {
        const { viewer, pagesInit, pagesLoaded } = createViewer();
        const old = createDocument();
        const oldRequests = old.requests;
        oldRequests.startup(request);
        attach(viewer, old.document);
        const original = observePages(viewer);
        const next = transition(viewer, old, kind);
        const current = observePages(viewer);
        expect(current.promise).not.toBe(original.promise);

        oldRequests.fail(request, new Error("Transport destroyed"));
        await drain();

        expectPending(original);
        expectPending(current);
        expect(pagesInit).not.toHaveBeenCalled();
        expect(pagesLoaded).not.toHaveBeenCalled();
        expect(viewer.pagesCount).toBe(0);
        expect(errors).not.toHaveBeenCalled();
        if (!next) {
          expect(viewer.pagesPromise).toBeNull();
          return;
        }
        next.requests.startup();
        next.requests.metadataRequest.resolve(metadata("en"));
        await drain();
        expect(viewer.pdfDocument).toBe(next.document);
        expect(pagesInit).toHaveBeenCalledOnce();
        expect(pagesLoaded).toHaveBeenCalledOnce();
        expect(current.resolved).toHaveBeenCalledOnce();
        expect(current.rejected).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
      });
    }

    it(`ignores late startup success after ${kind}`, async () => {
      const { viewer, element, pagesInit } = createViewer();
      const old = createDocument();
      const oldRequests = old.requests;
      attach(viewer, old.document);
      const next = transition(viewer, old, kind);
      const current = observePages(viewer);
      oldRequests.startup();
      await drain();

      expectPending(current);
      expect(viewer.pdfDocument).toBe(next?.document ?? null);
      expect(viewer.pagesCount).toBe(0);
      expect(element.childNodes).toHaveLength(0);
      expect(pagesInit).not.toHaveBeenCalled();
      expect(old.proxy.getMetadata).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    });
  }

  it.each(startupRequests)("preserves active %s failure", async (request) => {
    const { viewer, pagesInit } = createViewer();
    const fixture = createDocument();
    fixture.requests.startup(request);
    attach(viewer, fixture.document);
    const current = observePages(viewer);
    const failure = new Error(`Active ${request} failure`);
    fixture.requests.fail(request, failure);
    await drain();

    expect(current.rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(current.resolved).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledExactlyOnceWith("Unable to initialize viewer", failure);
    expect(pagesInit).not.toHaveBeenCalled();
    expect(viewer.pagesCount).toBe(0);
  });

  it("waits for optional content before constructing any page views", async () => {
    const { viewer, element, pagesInit } = createViewer();
    const fixture = createDocument();
    attach(viewer, fixture.document);
    fixture.requests.startup("optional-content");
    await drain();
    expect(viewer.pagesCount).toBe(0);
    expect(element.childNodes).toHaveLength(0);
    expect(pagesInit).not.toHaveBeenCalled();
    fixture.requests.startup();
    await drain();
    expect(viewer.getPageView(0)).toBeInstanceOf(engine.PDFPageView);
    expect(viewer.getPageView(0).pdfPage?.pageNumber).toBe(1);
    expect(pagesInit).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it("observes an optional-content failure while the first page is still pending", async () => {
    const { viewer, pagesInit } = createViewer();
    const fixture = createDocument();
    attach(viewer, fixture.document);
    const current = observePages(viewer);
    const failure = new Error("Optional content failed before page 1");
    fixture.requests.optionalContent.reject(failure);
    await drain();
    expect(current.rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(errors).toHaveBeenCalledExactlyOnceWith("Unable to initialize viewer", failure);
    expect(pagesInit).not.toHaveBeenCalled();
    fixture.requests.startup();
    await drain();
    expect(pagesInit).not.toHaveBeenCalled();
    expect(viewer.pagesCount).toBe(0);
  });
});

describe("installed PDFViewer eager-page ownership", () => {
  for (const kind of transitions) {
    it(`does not dispatch queued pagesloaded after ${kind}`, async () => {
      const { viewer, pagesLoaded } = createViewer();
      const old = createDocument(2);
      const oldRequests = old.requests;
      attach(viewer, old.document);
      const original = observePages(viewer);
      oldRequests.startup();
      await drain();
      expect(oldRequests.requestedPages).toEqual([1, 2]);

      // Registered after the engine's getPage reaction: that reaction resolves
      // pagesPromise, then this one detaches before its pagesloaded microtask.
      const switched = oldRequests.pages[1]!.promise.then(() => transition(viewer, old, kind));
      oldRequests.pages[1]!.resolve(page(2));
      await switched;
      const current = observePages(viewer);
      await drain();

      expect(original.resolved).toHaveBeenCalledOnce();
      expect(original.rejected).not.toHaveBeenCalled();
      expectPending(current);
      expect(pagesLoaded).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    });

    it.each(["success", "failure"] as const)(
      `ignores late eager-page %s after ${kind}`,
      async (outcome) => {
        const { viewer, pagesLoaded } = createViewer();
        const old = createDocument(2);
        const oldRequests = old.requests;
        attach(viewer, old.document);
        oldRequests.startup();
        await drain();
        expect(oldRequests.requestedPages).toEqual([1, 2]);
        const oldPageView = viewer.getPageView(1);
        expect(oldPageView).toBeInstanceOf(engine.PDFPageView);
        const next = transition(viewer, old, kind);
        const current = observePages(viewer);
        if (next) {
          next.requests.startup();
          await drain();
          expect(viewer.getPageView(1)).not.toBe(oldPageView);
        }
        if (outcome === "success") oldRequests.pages[1]!.resolve(page(2));
        else oldRequests.pages[1]!.reject(new Error("Transport destroyed"));
        await drain();

        expectPending(current);
        expect(oldPageView.pdfPage).toBeNull();
        expect(pagesLoaded).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        if (next) {
          expect(viewer.getPageView(1).pdfPage).toBeNull();
          const nextPage = page(2);
          next.requests.pages[1]!.resolve(nextPage);
          await drain();
          expect(viewer.getPageView(1).pdfPage).toBe(nextPage);
          expect(current.resolved).toHaveBeenCalledOnce();
          expect(current.rejected).not.toHaveBeenCalled();
          expect(pagesLoaded).toHaveBeenCalledOnce();
        }
      },
    );

    it.each(["success", "failure"] as const)(
      `stops the page-250 continuation after ${kind} (%s)`,
      async (outcome) => {
        const { viewer } = createViewer();
        const old = createDocument(251);
        const oldRequests = old.requests;
        attach(viewer, old.document);
        oldRequests.startup();
        for (let pageNumber = 2; pageNumber < 250; pageNumber += 1) {
          oldRequests.pages[pageNumber - 1]!.resolve(page(pageNumber));
        }
        await drain();
        expect(oldRequests.requestedPages).toEqual(
          Array.from({ length: 250 }, (_, index) => index + 1),
        );
        const next = transition(viewer, old, kind);
        const current = observePages(viewer);
        if (outcome === "success") oldRequests.pages[249]!.resolve(page(250));
        else oldRequests.pages[249]!.reject(new Error("Transport destroyed"));
        await drain();

        expect(oldRequests.requestedPages).toHaveLength(250);
        if (next) expect(next.requests.requestedPages).toEqual([1]);
        expectPending(current);
        expect(viewer.pagesCount).toBe(0);
        expect(errors).not.toHaveBeenCalled();
      },
    );
  }

  it("preserves active eager-page failure reporting and completion", async () => {
    const { viewer, pagesLoaded } = createViewer();
    const fixture = createDocument(2);
    attach(viewer, fixture.document);
    const current = observePages(viewer);
    fixture.requests.startup();
    await drain();
    const failure = new Error("Active page 2 failure");
    fixture.requests.pages[1]!.reject(failure);
    await drain();
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      "Unable to get page 2 to initialize viewer",
      failure,
    );
    expect(current.resolved).toHaveBeenCalledOnce();
    expect(current.rejected).not.toHaveBeenCalled();
    expect(pagesLoaded).toHaveBeenCalledOnce();
  });

  it("continues past page 250 and completes while the attachment remains current", async () => {
    const { viewer, pagesLoaded } = createViewer();
    const fixture = createDocument(251);
    attach(viewer, fixture.document);
    const current = observePages(viewer);
    fixture.requests.startup();
    for (let pageNumber = 2; pageNumber < 250; pageNumber += 1) {
      fixture.requests.pages[pageNumber - 1]!.resolve(page(pageNumber));
    }
    await drain();
    expect(fixture.requests.requestedPages).toHaveLength(250);
    expectPending(current);
    fixture.requests.pages[249]!.resolve(page(250));
    await drain();
    expect(fixture.requests.requestedPages).toHaveLength(251);
    expect(fixture.requests.requestedPages.at(-1)).toBe(251);
    expectPending(current);
    const lastPage = page(251);
    fixture.requests.pages[250]!.resolve(lastPage);
    await drain();
    expect(viewer.getPageView(250).pdfPage).toBe(lastPage);
    expect(current.resolved).toHaveBeenCalledOnce();
    expect(current.rejected).not.toHaveBeenCalled();
    expect(pagesLoaded).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("installed PDFViewer metadata ownership", () => {
  for (const kind of transitions) {
    it.each(["success", "failure"] as const)(
      `ignores stale metadata %s after ${kind}`,
      async (outcome) => {
        const { viewer, element } = createViewer();
        const old = createDocument();
        const oldRequests = old.requests;
        attach(viewer, old.document);
        oldRequests.startup();
        await drain();
        expect(old.proxy.getMetadata).toHaveBeenCalledOnce();
        const next = transition(viewer, old, kind);
        const current = observePages(viewer);
        if (next) {
          next.requests.startup();
          next.requests.metadataRequest.resolve(metadata("en"));
          await drain();
          expect(element.lang).toBe("en");
        }
        if (outcome === "success") oldRequests.metadataRequest.resolve(metadata("he"));
        else oldRequests.metadataRequest.reject(new Error("Transport destroyed"));
        await drain();

        expect(element.lang).toBe(next ? "en" : "");
        expect(current.rejected).not.toHaveBeenCalled();
        if (next) expect(current.resolved).toHaveBeenCalledOnce();
        else expectPending(current);
        expect(errors).not.toHaveBeenCalled();
      },
    );
  }

  it("reports an active metadata failure without rejecting initialized pages", async () => {
    const { viewer, element, pagesInit, pagesLoaded } = createViewer();
    const fixture = createDocument();
    attach(viewer, fixture.document);
    const current = observePages(viewer);
    fixture.requests.startup();
    await drain();
    const failure = new Error("Active metadata failure");
    fixture.requests.metadataRequest.reject(failure);
    await drain();

    expect(errors).toHaveBeenCalledExactlyOnceWith("Unable to get viewer metadata", failure);
    expect(current.resolved).toHaveBeenCalledOnce();
    expect(current.rejected).not.toHaveBeenCalled();
    expect(pagesInit).toHaveBeenCalledOnce();
    expect(pagesLoaded).toHaveBeenCalledOnce();
    expect(element.lang).toBe("");
  });
});
