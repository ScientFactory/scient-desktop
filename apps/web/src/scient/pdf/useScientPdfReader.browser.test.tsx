import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useLayoutEffect } from "react";
import { page } from "vite-plus/test/browser";

import { expect, it, vi } from "vite-plus/test";
import type { PdfSourceResolution, PdfSourceResolver } from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { ScientPdfReader } from "./ScientPdfReader";
import { webPdfSourceActions, workspacePdfSource } from "./pdfSource";
import { presentPdfSaveCopyResult } from "./pdfSaveCopyModel";
import { SourcePdfPreview } from "../sources/SourcePdfPreview";
import { useScientPdfReader } from "./useScientPdfReader";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  runtime: vi.fn(),
  prepare: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("./pdfRuntime", () => ({
  startPdfDocumentLoad: mocks.load,
  createPdfRuntime: mocks.runtime,
  FindState: {},
}));
vi.mock("./pdfPresentation", async (original) => ({
  ...(await original<object>()),
  preparePdfPresentation: mocks.prepare,
}));
vi.mock("../sources/client", () => ({
  readScientSourceAttachmentPreview: mocks.authorize,
}));
vi.mock("./pdfCopyAnalytics", () => ({
  observePdfCopy: (_environmentId: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("./pdfSaveCopyNotification", () => ({
  announcePdfSaveCopyResult: (result: Parameters<typeof presentPdfSaveCopyResult>[0]) =>
    presentPdfSaveCopyResult(result),
}));

const documentProxy = {
  numPages: 2,
  getOutline: async () => [],
  getPage: async () => ({
    getTextContent: async () => ({ items: [{ str: "text" }] }),
    cleanup: () => {},
  }),
};
function Probe({
  fixture: _fixture,
  url,
  revisionId,
  loadAttempt,
  candidateReady,
}: {
  fixture: _Fixture;
  url: string;
  revisionId: string;
  loadAttempt: number;
  candidateReady: boolean;
}) {
  const current = useScientPdfReader({
    documentKey: "same-document",
    revisionId,
    sourceUrl: url,
    loadAttempt,
    candidateReady,
    onSourceInvalidated: _fixture.refresh,
    container: _fixture.container,
    viewerElement: _fixture.viewerElement,
  });
  useLayoutEffect(() => {
    _fixture.publishReader(current);
  });
  return <textarea defaultValue="persistent input" />;
}
async function render(
  _fixture: _Fixture,
  url: string,
  revisionId = url,
  loadAttempt = 0,
  candidateReady = true,
) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <Probe
          fixture={_fixture}
          url={url}
          revisionId={revisionId}
          loadAttempt={loadAttempt}
          candidateReady={candidateReady}
        />,
      ),
  );
}
async function load(_fixture: _Fixture, index: number) {
  await vi.waitFor(() => expect(_fixture.tasks[index]).toBeDefined());
  await act(async () => {
    _fixture.tasks[index]!.resolve(documentProxy);
    await Promise.resolve();
  });
  await act(() => _fixture.runtimes.at(-1).emit("pagesinit", {}));
}
async function publish(_fixture: _Fixture, index: number) {
  await act(async () => _fixture.preparations[index]!.resolve());
}
async function _setupFixture0(_fixture: _Fixture) {
  _fixture.tasks.length = _fixture.runtimes.length = _fixture.preparations.length = 0;
  mocks.authorize.mockReset();
  mocks.load.mockReset().mockImplementation(() => {
    let resolve!: (doc: any) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const task = { resolve, reject, destroy: vi.fn(async () => {}) };
    _fixture.tasks.push(task);
    return { ...task, promise };
  });
  mocks.prepare.mockReset().mockImplementation(
    ({ signal }) =>
      new Promise<void>((resolve, reject) => {
        _fixture.preparations.push({ resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("obsolete", "AbortError")), {
          once: true,
        });
      }),
  );
  mocks.runtime.mockReset().mockImplementation((input) => {
    const listeners = new Map<string, (event: any) => void>();
    const page = document.createElement("div");
    page.className = "page";
    page.textContent = input.sourceUrl;
    input.viewerElement.append(page);
    const runtime = {
      document: documentProxy,
      viewer: {
        currentPageNumber: 1,
        currentScale: 1,
        currentScaleValue: "1",
        pagesRotation: 0,
        scrollPageIntoView: vi.fn(),
        getPageView: () => undefined,
      },
      eventBus: {
        on: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
        dispatch: vi.fn(),
      },
      emit: (name: string, event: any) => listeners.get(name)?.(event),
      refreshForContainerSize: vi.fn(),
      cancelContainerSizeRefresh: vi.fn(),
      destroy: vi.fn(async () => input.viewerElement.replaceChildren()),
    };
    _fixture.runtimes.push(runtime);
    return runtime;
  });
  _fixture.mount = document.createElement("div");
  _fixture.container = document.createElement("div");
  _fixture.viewerElement = document.createElement("div");
  _fixture.container.append(_fixture.viewerElement);
  document.body.append(_fixture.mount, _fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.mount, router: false }),
  );
  _fixture.refresh = vi.fn();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.mount.remove();
  _fixture.container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

it("publishes the painted container and its source identity atomically after replacement readiness", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "A", "revision-a");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  const oldPresentation = _fixture.reader.presentation;
  const oldContainer = oldPresentation?.container;
  expect(oldPresentation).toMatchObject({
    documentKey: "same-document",
    revisionId: "revision-a",
    sourceUrl: "A",
  });
  const input = _fixture.mount.querySelector("textarea")!;
  input.focus();
  _fixture.refresh = vi.fn();
  await render(_fixture, "A", "revision-a");
  expect(mocks.load).toHaveBeenCalledTimes(1);
  await render(_fixture, "B", "revision-b");
  expect(_fixture.reader.state.phase).toBe("ready");
  expect(_fixture.reader.state.loadedSourceUrl).toBe("A");
  expect(_fixture.reader.presentation).toBe(oldPresentation);
  expect(_fixture.reader.presentation).toMatchObject({ revisionId: "revision-a", sourceUrl: "A" });
  expect(_fixture.runtimes[0].destroy).not.toHaveBeenCalled();
  await load(_fixture, 1);
  expect(_fixture.reader.presentation).toBe(oldPresentation);
  expect(_fixture.reader.presentation?.container).toBe(oldContainer);
  expect(_fixture.reader.presentation).toMatchObject({ revisionId: "revision-a", sourceUrl: "A" });
  expect(_fixture.viewerElement.querySelectorAll(".page").length).toBe(2);
  expect(
    _fixture.viewerElement.querySelector(".scient-pdf-staging")?.getAttribute("aria-hidden"),
  ).toBe("true");
  await publish(_fixture, 1);
  expect(_fixture.reader.state.loadedSourceUrl).toBe("B");
  expect(_fixture.reader.presentation?.container).not.toBe(oldContainer);
  expect(_fixture.reader.presentation).toMatchObject({
    documentKey: "same-document",
    revisionId: "revision-b",
    sourceUrl: "B",
  });
  expect(_fixture.runtimes[0].destroy).toHaveBeenCalledTimes(1);
  expect(_fixture.viewerElement.querySelectorAll(".page").length).toBe(1);
  expect(document.activeElement).toBe(input);
  expect(_fixture.reader.state.updating).toBe(false);
});

it("treats a changed immutable revision as a replacement even when its capability URL is reused", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "shared-url", "revision-a");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  const oldPresentation = _fixture.reader.presentation;

  await render(_fixture, "shared-url", "revision-b");
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(_fixture.reader.presentation).toBe(oldPresentation);
  expect(_fixture.reader.presentation?.revisionId).toBe("revision-a");

  await load(_fixture, 1);
  await publish(_fixture, 1);
  expect(_fixture.reader.presentation).toMatchObject({
    revisionId: "revision-b",
    sourceUrl: "shared-url",
  });
});
it("discards obsolete preparations without ever replacing the current page with stale output", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "A");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  await render(_fixture, "B");
  await load(_fixture, 1);
  await render(_fixture, "C");
  expect(_fixture.runtimes[1].destroy).toHaveBeenCalledTimes(1);
  expect(_fixture.runtimes[0].destroy).not.toHaveBeenCalled();
  await publish(_fixture, 1);
  expect(_fixture.reader.state.loadedSourceUrl).toBe("A");
  await load(_fixture, 2);
  await publish(_fixture, 2);
  expect(_fixture.reader.state.loadedSourceUrl).toBe("C");
  expect(_fixture.viewerElement.querySelectorAll(".page").length).toBe(1);
});

it("retains the displayed page on failed loads and failed rendering", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "A");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  await render(_fixture, "B");
  await act(() => _fixture.tasks[1]!.reject(new Error("network failure")));
  expect(_fixture.reader.state.phase).toBe("ready");
  expect(_fixture.reader.state.loadedSourceUrl).toBe("A");
  expect(_fixture.reader.state.updateError).toBeTruthy();
  await render(_fixture, "C");
  await load(_fixture, 2);
  await act(() => _fixture.preparations[1]!.reject(new Error("render failure")));
  expect(_fixture.reader.state.loadedSourceUrl).toBe("A");
  expect(_fixture.runtimes[0].destroy).not.toHaveBeenCalled();
  expect(_fixture.viewerElement.querySelectorAll(".page").length).toBe(1);
});
it("releases both displayed and pending presentations at document unmount", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "A");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  await render(_fixture, "B");
  await load(_fixture, 1);
  await act(async () => await _fixture.root0.rerender(null));
  expect(_fixture.runtimes[0].destroy).toHaveBeenCalledTimes(1);
  expect(_fixture.runtimes[1].destroy).toHaveBeenCalledTimes(1);
  expect(_fixture.viewerElement.children.length).toBe(0);
});

it("stress-tests fifty revisions without accumulating page surfaces or resetting focused input", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "revision-0");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  const input = _fixture.mount.querySelector("textarea")!;
  input.focus();
  for (let revision = 1; revision <= 50; revision++) {
    await render(_fixture, `revision-${revision}`);
    expect(_fixture.reader.state.phase).toBe("ready");
    expect(_fixture.viewerElement.children.length).toBe(2);
    await load(_fixture, revision);
    await publish(_fixture, revision);
    expect(_fixture.reader.state.loadedSourceUrl).toBe(`revision-${revision}`);
    expect(_fixture.viewerElement.children.length).toBe(1);
    expect(document.activeElement).toBe(input);
  }
  expect(
    _fixture.runtimes.slice(0, -1).every((runtime) => runtime.destroy.mock.calls.length === 1),
  ).toBe(true);
});

it("keeps the painted viewport through authorization and same-URL decode retries without remounting", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const source = workspacePdfSource({
    environmentId: EnvironmentId.make("retained-retry-environment"),
    workspaceRoot: "/synthetic",
    relativePath: "retry.pdf",
    fileName: "Retry.pdf",
  });
  let authorization: PdfSourceResolution;
  let pendingAuthorization: PdfSourceResolution;
  const renew = vi.fn(() => {
    authorization = pendingAuthorization;
  });
  const asset = (url: string, waiting = false): PdfSourceResolution => ({
    _tag: "Success",
    url,
    expiresAt: 10_000,
    waiting,
    refresh: renew,
  });
  const resolver: PdfSourceResolver = { useResolve: () => authorization };
  const renderDocument = async (next: PdfSourceResolution) => {
    authorization = next;
    await act(
      async () =>
        await _fixture.root0.rerender(<ScientPdfReader source={source} resolver={resolver} />),
    );
  };
  const retry = async () => {
    const button = Array.from(_fixture.mount.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Try again",
    );
    expect(button?.disabled).toBe(false);
    await act(() => button!.click());
  };

  await renderDocument(asset("A"));
  await load(_fixture, 0);
  await publish(_fixture, 0);
  const painted = _fixture.mount.querySelector<HTMLDivElement>(".scient-pdf-viewer-container")!;
  const search = _fixture.mount.querySelector('input[aria-label="Search PDF"]');
  painted.scrollTop = 230;
  painted.scrollLeft = 14;
  _fixture.runtimes[0].viewer.currentScale = 1.75;
  await act(() => _fixture.runtimes[0].emit("scalechanging", { scale: 1.75 }));
  const expectRetained = () => {
    expect(painted.isConnected).toBe(true);
    expect(painted.textContent).toBe("A");
    expect(painted.scrollTop).toBe(230);
    expect(painted.scrollLeft).toBe(14);
    expect(_fixture.runtimes[0].viewer.currentScale).toBe(1.75);
    expect(_fixture.runtimes[0].destroy).not.toHaveBeenCalled();
    expect(_fixture.mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
  };

  await renderDocument({ _tag: "Failure", refresh: renew });
  expectRetained();
  pendingAuthorization = { _tag: "Failure", waiting: true, refresh: renew };
  await retry();
  expectRetained();
  expect(_fixture.tasks).toHaveLength(1);
  expect(
    _fixture.mount.querySelector<HTMLButtonElement>(".scient-pdf-update-notice button")?.disabled,
  ).toBe(true);

  await renderDocument(asset("B"));
  const invalidPdf = new Error("invalid bytes");
  invalidPdf.name = "InvalidPDFException";
  await act(() => _fixture.tasks[1]!.reject(invalidPdf));
  expectRetained();
  expect(_fixture.mount.textContent).toContain("This file is not a valid PDF.");
  pendingAuthorization = asset("B", true);
  await retry();
  expectRetained();
  expect(_fixture.tasks).toHaveLength(2);
  await renderDocument(asset("B"));
  expect(mocks.load.mock.calls.map(([url]) => url)).toEqual(["A", "B", "B"]);
  await load(_fixture, 2);
  expectRetained();
  await publish(_fixture, 1);
  expect(painted.isConnected).toBe(false);
  expect(_fixture.mount.querySelector(".scient-pdf-viewer-container")?.textContent).toBe("B");
  expect(_fixture.runtimes[0].destroy).toHaveBeenCalledTimes(1);
  expect(_fixture.mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
  expect(renew).toHaveBeenCalledTimes(2);
});

it("fences superseded same-URL attempts even when their preparation ignores cancellation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.prepare.mockImplementation(() => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    _fixture.preparations.push({ resolve, reject });
    return promise;
  });
  await render(_fixture, "A");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  const painted = _fixture.reader.presentation;

  await render(_fixture, "B", "revision-b", 0);
  await load(_fixture, 1);
  await render(_fixture, "B", "revision-b", 1, false);
  expect(_fixture.reader.presentationCurrent).toBe(false);
  expect(_fixture.reader.presentation).toBe(painted);
  expect(_fixture.runtimes[1].destroy).toHaveBeenCalledTimes(1);
  await publish(_fixture, 1);
  expect(_fixture.reader.presentation).toBe(painted);
  expect(_fixture.reader.state.loadedSourceUrl).toBe("A");

  await render(_fixture, "B", "revision-b", 1);
  await render(_fixture, "B", "revision-b", 2, false);
  const changedSource = Object.assign(new Error("superseded"), {
    name: "UnexpectedResponseException",
    status: 409,
  });
  await act(() => _fixture.tasks[2]!.reject(changedSource));
  expect(_fixture.refresh).not.toHaveBeenCalled();
  expect(_fixture.reader.state.updateError).toBeNull();
  expect(_fixture.reader.presentation).toBe(painted);

  await render(_fixture, "B", "revision-b", 2);
  await load(_fixture, 3);
  expect(_fixture.reader.presentationCurrent).toBe(false);
  expect(_fixture.runtimes[0].destroy).not.toHaveBeenCalled();
  await publish(_fixture, 2);
  expect(_fixture.reader.presentation).toMatchObject({ sourceUrl: "B", revisionId: "revision-b" });
  expect(_fixture.reader.presentationCurrent).toBe(true);
  expect(_fixture.runtimes[0].destroy).toHaveBeenCalledTimes(1);
});

function sourceAuthorizationFixture(_fixture: _Fixture) {
  const requests: {
    resolve: (value: { url: string; expiresAt: number; sourcePath: string }) => void;
    reject: (error: Error) => void;
  }[] = [];
  mocks.authorize.mockImplementation(() => {
    const { promise, resolve, reject } = Promise.withResolvers<{
      url: string;
      expiresAt: number;
      sourcePath: string;
    }>();
    requests.push({ resolve, reject });
    return promise;
  });
  const open = async () => {
    await act(async () => {
      await _fixture.root0.rerender(
        <SourcePdfPreview
          environmentId={EnvironmentId.make("source-retry-environment")}
          root="/synthetic"
          sourceId="source-retry"
          attachmentId="attachment-retry"
          fileName="Source retry.pdf"
        />,
      );
    });
  };
  const authorize = async (index: number, url: string) => {
    await vi.waitFor(() => expect(requests[index]).toBeDefined());
    await act(async () =>
      requests[index]!.resolve({ url, expiresAt: 10_000, sourcePath: "source-retry.pdf" }),
    );
  };
  const click = async (text: string) => {
    if (text === "Save a copy") {
      await _fixture.root0.getByRole("button", { name: "More PDF actions" }).click();
      await page.getByRole("menuitem", { name: text }).click();
      return;
    }
    const button = Array.from(_fixture.mount.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button!.click());
  };
  return { requests, open, authorize, click };
}

it("recovers an initial Sources authorization failure without fetching before renewal settles", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const source = sourceAuthorizationFixture(_fixture);
  await source.open();
  await act(() => source.requests[0]!.reject(new Error("authorization failed")));
  expect(_fixture.mount.textContent).toContain("Couldn't open this PDF");
  await source.click("Try again");
  expect(_fixture.mount.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(_fixture.tasks).toHaveLength(0);
  await source.authorize(1, "source-A");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  expect(_fixture.mount.querySelector(".scient-pdf-viewer-container")?.textContent).toBe(
    "source-A",
  );
});

it("retains a Sources PDF through reauthorization failures and ignores superseded authorization", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  vi.spyOn(webPdfSourceActions, "saveCopy").mockResolvedValue({
    _tag: "failed",
    reason: "source-changed",
  });
  const source = sourceAuthorizationFixture(_fixture);
  await source.open();
  await source.authorize(0, "source-A");
  await load(_fixture, 0);
  await publish(_fixture, 0);
  const painted = _fixture.mount.querySelector<HTMLDivElement>(".scient-pdf-viewer-container")!;
  const search = _fixture.mount.querySelector('input[aria-label="Search PDF"]');
  painted.scrollTop = 190;

  // Save Copy discovers changed bytes and starts the normal authorization renewal.
  await source.click("Save a copy");
  await source.click("Save a copy");
  await source.authorize(1, "superseded-source");
  expect(_fixture.tasks).toHaveLength(1);
  expect(painted.isConnected).toBe(true);
  await act(() => source.requests[2]!.reject(new Error("authorization failed")));
  await source.click("Try again");
  expect(_fixture.tasks).toHaveLength(1);
  expect(_fixture.mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
  expect(painted.scrollTop).toBe(190);
  expect(_fixture.runtimes[0].destroy).not.toHaveBeenCalled();

  await source.authorize(3, "source-B");
  const invalid = Object.assign(new Error("invalid bytes"), { name: "InvalidPDFException" });
  await act(() => _fixture.tasks[1]!.reject(invalid));
  expect(painted.isConnected).toBe(true);
  await source.click("Try again");
  expect(_fixture.tasks).toHaveLength(2);
  expect(painted.scrollTop).toBe(190);
  await source.authorize(4, "source-B");
  expect(mocks.load.mock.calls.map(([url]) => url)).toEqual(["source-A", "source-B", "source-B"]);
  await load(_fixture, 2);
  expect(painted.isConnected).toBe(true);
  await publish(_fixture, 1);
  expect(painted.isConnected).toBe(false);
  expect(_fixture.mount.querySelector(".scient-pdf-viewer-container")?.textContent).toBe(
    "source-B",
  );
  expect(_fixture.mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  let reader: ReturnType<typeof useScientPdfReader> = undefined!;
  let refresh: () => void = undefined!;
  const tasks: {
    resolve: (doc: any) => void;
    reject: (error: Error) => void;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const runtimes: any[] = [];
  const preparations: { resolve: () => void; reject: (error: Error) => void }[] = [];
  return {
    get reader() {
      return reader;
    },
    publishReader: (next: typeof reader) => {
      reader = next;
    },
    refresh,
    tasks,
    runtimes,
    preparations,
    mount: undefined! as HTMLDivElement,
    container: undefined! as HTMLDivElement,
    viewerElement: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
