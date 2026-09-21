// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { type RequestedPdfPresentation, useScientPdfReader } from "./useScientPdfReader";

const mocks = vi.hoisted(() => ({ load: vi.fn(), runtime: vi.fn(), prepare: vi.fn() }));
vi.mock("./pdfRuntime", () => ({
  startPdfDocumentLoad: mocks.load,
  createPdfRuntime: mocks.runtime,
  FindState: {},
}));
vi.mock("./pdfPresentation", async (original) => ({
  ...(await original<object>()),
  preparePdfPresentation: mocks.prepare,
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
  getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "text" }] }) }),
};
function Probe({
  url,
  revisionId,
  canPublish,
}: {
  url: string;
  revisionId: string;
  canPublish: (candidate: RequestedPdfPresentation) => boolean;
}) {
  reader = useScientPdfReader({
    canPublishPresentation: canPublish,
    documentKey: "same-document",
    revisionId,
    sourceUrl: url,
    onSourceInvalidated: refresh,
    container,
    viewerElement,
  });
  return <textarea defaultValue="persistent input" />;
}
const allowPublication = () => true;
const holdPublication = () => false;
async function render(
  url: string,
  revisionId = url,
  canPublish: (candidate: RequestedPdfPresentation) => boolean = allowPublication,
) {
  await act(() => root.render(<Probe url={url} revisionId={revisionId} canPublish={canPublish} />));
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
it("always admits the first readable PDF even when its producer cannot authorize replacements", async () => {
  await render("legacy-A", "revision-a", holdPublication);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  await load(0);
  await publish(0);
  expect(reader.presentation).toMatchObject({
    revisionId: "revision-a",
    sourceUrl: "legacy-A",
  });

  await render("legacy-B", "revision-b", holdPublication);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(reader.presentation).toMatchObject({
    revisionId: "revision-a",
    sourceUrl: "legacy-A",
  });
});
it("cannot use a newer revision's permission to publish an older retained candidate", async () => {
  await render("A", "revision-a");
  await load(0);
  await publish(0);
  const presentationA = reader.presentation;
  const allowOnlyC = vi.fn(
    (candidate: { readonly revisionId: string | null }) => candidate.revisionId === "revision-c",
  );

  // This is the shape produced while C's asset authorization is still loading:
  // the retained resolved input is B, while the live source proof belongs to C.
  await render("B", "revision-b", allowOnlyC);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(allowOnlyC).toHaveBeenLastCalledWith({
    documentKey: "same-document",
    revisionId: "revision-b",
    sourceUrl: "B",
  });
  expect(reader.presentation).toBe(presentationA);

  await render("C", "revision-c", allowOnlyC);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  await load(1);
  await publish(1);
  expect(reader.presentation).toMatchObject({ revisionId: "revision-c", sourceUrl: "C" });
  expect(reader.presentation?.revisionId).not.toBe("revision-b");
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
it("holds an in-flight replacement through active editing and publishes only the later exact revision", async () => {
  await render("A", "revision-a");
  await load(0);
  await publish(0);
  const presentationA = reader.presentation;
  const input = mount.querySelector("textarea")!;
  input.focus();

  // B was exact when staging began. Editing starts before its prepared page
  // crosses the paint fence, so B must be discarded without disturbing A.
  await render("B", "revision-b");
  await load(1);
  expect(viewerElement.querySelectorAll(".page").length).toBe(2);
  await render("B", "revision-b", holdPublication);
  expect(runtimes[1].destroy).toHaveBeenCalledTimes(1);
  await publish(1);
  expect(reader.presentation).toBe(presentationA);
  expect(reader.presentation).toMatchObject({ revisionId: "revision-a", sourceUrl: "A" });
  expect(reader.state.updating).toBe(false);
  expect(document.activeElement).toBe(input);

  // The source advances again while editing. Neither the completed B artifact
  // nor C may stage until C is proven to own the current source.
  await render("C", "revision-c", holdPublication);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(reader.presentation).toBe(presentationA);
  expect(document.activeElement).toBe(input);

  await render("C", "revision-c", allowPublication);
  expect(mocks.load).toHaveBeenCalledTimes(3);
  await load(2);
  expect(reader.presentation).toBe(presentationA);
  await publish(2);
  expect(reader.presentation).toMatchObject({ revisionId: "revision-c", sourceUrl: "C" });
  expect(reader.presentation?.revisionId).not.toBe("revision-b");
  expect(document.activeElement).toBe(input);
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
