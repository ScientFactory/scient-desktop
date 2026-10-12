// @vitest-environment happy-dom
import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
vi.mock("~/components/ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: ComponentProps<"button">) => <button>{children}</button>,
}));
let root: Root;
let mount: HTMLDivElement;
let container: HTMLDivElement;
let viewerElement: HTMLDivElement;
let reader: ReturnType<typeof useScientPdfReader>;
let refresh: () => void;
const tasks: {
  resolve: (doc: any) => void;
  reject: (error: Error) => void;
  destroy: ReturnType<typeof vi.fn>;
}[] = [];
const runtimes: any[] = [];
const preparations: { resolve: () => void; reject: (error: Error) => void }[] = [];
const documentProxy = {
  numPages: 2,
  getOutline: async () => [],
  getPage: async () => ({
    getTextContent: async () => ({ items: [{ str: "text" }] }),
    cleanup: () => {},
  }),
};
function Probe({
  url,
  revisionId,
  loadAttempt,
  candidateReady,
}: {
  url: string;
  revisionId: string;
  loadAttempt: number;
  candidateReady: boolean;
}) {
  reader = useScientPdfReader({
    documentKey: "same-document",
    revisionId,
    sourceUrl: url,
    loadAttempt,
    candidateReady,
    onSourceInvalidated: refresh,
    container,
    viewerElement,
  });
  return <textarea defaultValue="persistent input" />;
}
async function render(url: string, revisionId = url, loadAttempt = 0, candidateReady = true) {
  await act(() =>
    root.render(
      <Probe
        url={url}
        revisionId={revisionId}
        loadAttempt={loadAttempt}
        candidateReady={candidateReady}
      />,
    ),
  );
}
async function load(index: number) {
  await act(async () => {
    tasks[index]!.resolve(documentProxy);
    await Promise.resolve();
  });
  await act(() => runtimes.at(-1).emit("pagesinit", {}));
}
async function publish(index: number) {
  await act(async () => preparations[index]!.resolve());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  tasks.length = runtimes.length = preparations.length = 0;
  mocks.authorize.mockReset();
  mocks.load.mockReset().mockImplementation(() => {
    let resolve!: (doc: any) => void, reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const task = { resolve, reject, destroy: vi.fn(async () => {}) };
    tasks.push(task);
    return { ...task, promise };
  });
  mocks.prepare.mockReset().mockImplementation(
    ({ signal }) =>
      new Promise<void>((resolve, reject) => {
        preparations.push({ resolve, reject });
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
    runtimes.push(runtime);
    return runtime;
  });
  mount = document.createElement("div");
  container = document.createElement("div");
  viewerElement = document.createElement("div");
  container.append(viewerElement);
  document.body.append(mount, container);
  root = createRoot(mount);
  refresh = vi.fn();
});
afterEach(async () => {
  await act(() => root.unmount());
  mount.remove();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("publishes the painted container and its source identity atomically after replacement readiness", async () => {
  await render("A", "revision-a");
  await load(0);
  await publish(0);
  const oldPresentation = reader.presentation;
  const oldContainer = oldPresentation?.container;
  expect(oldPresentation).toMatchObject({
    documentKey: "same-document",
    revisionId: "revision-a",
    sourceUrl: "A",
  });
  const input = mount.querySelector("textarea")!;
  input.focus();
  refresh = vi.fn();
  await render("A", "revision-a");
  expect(mocks.load).toHaveBeenCalledTimes(1);
  await render("B", "revision-b");
  expect(reader.state.phase).toBe("ready");
  expect(reader.state.loadedSourceUrl).toBe("A");
  expect(reader.presentation).toBe(oldPresentation);
  expect(reader.presentation).toMatchObject({ revisionId: "revision-a", sourceUrl: "A" });
  expect(runtimes[0].destroy).not.toHaveBeenCalled();
  await load(1);
  expect(reader.presentation).toBe(oldPresentation);
  expect(reader.presentation?.container).toBe(oldContainer);
  expect(reader.presentation).toMatchObject({ revisionId: "revision-a", sourceUrl: "A" });
  expect(viewerElement.querySelectorAll(".page").length).toBe(2);
  expect(viewerElement.querySelector(".scient-pdf-staging")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  await publish(1);
  expect(reader.state.loadedSourceUrl).toBe("B");
  expect(reader.presentation?.container).not.toBe(oldContainer);
  expect(reader.presentation).toMatchObject({
    documentKey: "same-document",
    revisionId: "revision-b",
    sourceUrl: "B",
  });
  expect(runtimes[0].destroy).toHaveBeenCalledTimes(1);
  expect(viewerElement.querySelectorAll(".page").length).toBe(1);
  expect(document.activeElement).toBe(input);
  expect(reader.state.updating).toBe(false);
});

it("treats a changed immutable revision as a replacement even when its capability URL is reused", async () => {
  await render("shared-url", "revision-a");
  await load(0);
  await publish(0);
  const oldPresentation = reader.presentation;

  await render("shared-url", "revision-b");
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(reader.presentation).toBe(oldPresentation);
  expect(reader.presentation?.revisionId).toBe("revision-a");

  await load(1);
  await publish(1);
  expect(reader.presentation).toMatchObject({
    revisionId: "revision-b",
    sourceUrl: "shared-url",
  });
});
it("discards obsolete preparations without ever replacing the current page with stale output", async () => {
  await render("A");
  await load(0);
  await publish(0);
  await render("B");
  await load(1);
  await render("C");
  expect(runtimes[1].destroy).toHaveBeenCalledTimes(1);
  expect(runtimes[0].destroy).not.toHaveBeenCalled();
  await publish(1);
  expect(reader.state.loadedSourceUrl).toBe("A");
  await load(2);
  await publish(2);
  expect(reader.state.loadedSourceUrl).toBe("C");
  expect(viewerElement.querySelectorAll(".page").length).toBe(1);
});

it("retains the displayed page on failed loads and failed rendering", async () => {
  await render("A");
  await load(0);
  await publish(0);
  await render("B");
  await act(() => tasks[1]!.reject(new Error("network failure")));
  expect(reader.state.phase).toBe("ready");
  expect(reader.state.loadedSourceUrl).toBe("A");
  expect(reader.state.updateError).toBeTruthy();
  await render("C");
  await load(2);
  await act(() => preparations[1]!.reject(new Error("render failure")));
  expect(reader.state.loadedSourceUrl).toBe("A");
  expect(runtimes[0].destroy).not.toHaveBeenCalled();
  expect(viewerElement.querySelectorAll(".page").length).toBe(1);
});
it("releases both displayed and pending presentations at document unmount", async () => {
  await render("A");
  await load(0);
  await publish(0);
  await render("B");
  await load(1);
  await act(() => root.render(null));
  expect(runtimes[0].destroy).toHaveBeenCalledTimes(1);
  expect(runtimes[1].destroy).toHaveBeenCalledTimes(1);
  expect(viewerElement.children.length).toBe(0);
});

it("stress-tests fifty revisions without accumulating page surfaces or resetting focused input", async () => {
  await render("revision-0");
  await load(0);
  await publish(0);
  const input = mount.querySelector("textarea")!;
  input.focus();
  for (let revision = 1; revision <= 50; revision++) {
    await render(`revision-${revision}`);
    expect(reader.state.phase).toBe("ready");
    expect(viewerElement.children.length).toBe(2);
    await load(revision);
    await publish(revision);
    expect(reader.state.loadedSourceUrl).toBe(`revision-${revision}`);
    expect(viewerElement.children.length).toBe(1);
    expect(document.activeElement).toBe(input);
  }
  expect(runtimes.slice(0, -1).every((runtime) => runtime.destroy.mock.calls.length === 1)).toBe(
    true,
  );
});

it("keeps the painted viewport through authorization and same-URL decode retries without remounting", async () => {
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
    await act(() => root.render(<ScientPdfReader source={source} resolver={resolver} />));
  };
  const retry = async () => {
    const button = Array.from(mount.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Try again",
    );
    expect(button?.disabled).toBe(false);
    await act(() => button!.click());
  };

  await renderDocument(asset("A"));
  await load(0);
  await publish(0);
  const painted = mount.querySelector<HTMLDivElement>(".scient-pdf-viewer-container")!;
  const search = mount.querySelector('input[aria-label="Search PDF"]');
  painted.scrollTop = 230;
  painted.scrollLeft = 14;
  runtimes[0].viewer.currentScale = 1.75;
  await act(() => runtimes[0].emit("scalechanging", { scale: 1.75 }));
  const expectRetained = () => {
    expect(painted.isConnected).toBe(true);
    expect(painted.textContent).toBe("A");
    expect(painted.scrollTop).toBe(230);
    expect(painted.scrollLeft).toBe(14);
    expect(runtimes[0].viewer.currentScale).toBe(1.75);
    expect(runtimes[0].destroy).not.toHaveBeenCalled();
    expect(mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
  };

  await renderDocument({ _tag: "Failure", refresh: renew });
  expectRetained();
  pendingAuthorization = { _tag: "Failure", waiting: true, refresh: renew };
  await retry();
  expectRetained();
  expect(tasks).toHaveLength(1);
  expect(mount.querySelector<HTMLButtonElement>(".scient-pdf-update-notice button")?.disabled).toBe(
    true,
  );

  await renderDocument(asset("B"));
  const invalidPdf = new Error("invalid bytes");
  invalidPdf.name = "InvalidPDFException";
  await act(() => tasks[1]!.reject(invalidPdf));
  expectRetained();
  expect(mount.textContent).toContain("This file is not a valid PDF.");
  pendingAuthorization = asset("B", true);
  await retry();
  expectRetained();
  expect(tasks).toHaveLength(2);
  await renderDocument(asset("B"));
  expect(mocks.load.mock.calls.map(([url]) => url)).toEqual(["A", "B", "B"]);
  await load(2);
  expectRetained();
  await publish(1);
  expect(painted.isConnected).toBe(false);
  expect(mount.querySelector(".scient-pdf-viewer-container")?.textContent).toBe("B");
  expect(runtimes[0].destroy).toHaveBeenCalledTimes(1);
  expect(mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
  expect(renew).toHaveBeenCalledTimes(2);
});

it("fences superseded same-URL attempts even when their preparation ignores cancellation", async () => {
  mocks.prepare.mockImplementation(() => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    preparations.push({ resolve, reject });
    return promise;
  });
  await render("A");
  await load(0);
  await publish(0);
  const painted = reader.presentation;

  await render("B", "revision-b", 0);
  await load(1);
  await render("B", "revision-b", 1, false);
  expect(reader.presentationCurrent).toBe(false);
  expect(reader.presentation).toBe(painted);
  expect(runtimes[1].destroy).toHaveBeenCalledTimes(1);
  await publish(1);
  expect(reader.presentation).toBe(painted);
  expect(reader.state.loadedSourceUrl).toBe("A");

  await render("B", "revision-b", 1);
  await render("B", "revision-b", 2, false);
  const changedSource = Object.assign(new Error("superseded"), {
    name: "UnexpectedResponseException",
    status: 409,
  });
  await act(() => tasks[2]!.reject(changedSource));
  expect(refresh).not.toHaveBeenCalled();
  expect(reader.state.updateError).toBeNull();
  expect(reader.presentation).toBe(painted);

  await render("B", "revision-b", 2);
  await load(3);
  expect(reader.presentationCurrent).toBe(false);
  expect(runtimes[0].destroy).not.toHaveBeenCalled();
  await publish(2);
  expect(reader.presentation).toMatchObject({ sourceUrl: "B", revisionId: "revision-b" });
  expect(reader.presentationCurrent).toBe(true);
  expect(runtimes[0].destroy).toHaveBeenCalledTimes(1);
});

function sourceAuthorizationFixture() {
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
      root.render(
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
    await act(async () =>
      requests[index]!.resolve({ url, expiresAt: 10_000, sourcePath: "source-retry.pdf" }),
    );
  };
  const click = async (text: string) => {
    const button = Array.from(mount.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button!.click());
  };
  return { requests, open, authorize, click };
}

it("recovers an initial Sources authorization failure without fetching before renewal settles", async () => {
  const source = sourceAuthorizationFixture();
  await source.open();
  await act(() => source.requests[0]!.reject(new Error("authorization failed")));
  expect(mount.textContent).toContain("Couldn't open this PDF");
  await source.click("Try again");
  expect(mount.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(tasks).toHaveLength(0);
  await source.authorize(1, "source-A");
  await load(0);
  await publish(0);
  expect(mount.querySelector(".scient-pdf-viewer-container")?.textContent).toBe("source-A");
});

it("retains a Sources PDF through reauthorization failures and ignores superseded authorization", async () => {
  vi.spyOn(webPdfSourceActions, "saveCopy").mockResolvedValue({
    _tag: "failed",
    reason: "source-changed",
  });
  const source = sourceAuthorizationFixture();
  await source.open();
  await source.authorize(0, "source-A");
  await load(0);
  await publish(0);
  const painted = mount.querySelector<HTMLDivElement>(".scient-pdf-viewer-container")!;
  const search = mount.querySelector('input[aria-label="Search PDF"]');
  painted.scrollTop = 190;

  // Save Copy discovers changed bytes and starts the normal authorization renewal.
  await source.click("Save a copy");
  await source.click("Save a copy");
  await source.authorize(1, "superseded-source");
  expect(tasks).toHaveLength(1);
  expect(painted.isConnected).toBe(true);
  await act(() => source.requests[2]!.reject(new Error("authorization failed")));
  await source.click("Try again");
  expect(tasks).toHaveLength(1);
  expect(mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
  expect(painted.scrollTop).toBe(190);
  expect(runtimes[0].destroy).not.toHaveBeenCalled();

  await source.authorize(3, "source-B");
  const invalid = Object.assign(new Error("invalid bytes"), { name: "InvalidPDFException" });
  await act(() => tasks[1]!.reject(invalid));
  expect(painted.isConnected).toBe(true);
  await source.click("Try again");
  expect(tasks).toHaveLength(2);
  expect(painted.scrollTop).toBe(190);
  await source.authorize(4, "source-B");
  expect(mocks.load.mock.calls.map(([url]) => url)).toEqual(["source-A", "source-B", "source-B"]);
  await load(2);
  expect(painted.isConnected).toBe(true);
  await publish(1);
  expect(painted.isConnected).toBe(false);
  expect(mount.querySelector(".scient-pdf-viewer-container")?.textContent).toBe("source-B");
  expect(mount.querySelector('input[aria-label="Search PDF"]')).toBe(search);
});
