import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type ScientDocumentHostRequest,
  type ScientDocumentHostStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type StreamResult = AsyncResult.AsyncResult<ScientDocumentHostStreamEvent, Error>;
const mocks = vi.hoisted(() => ({
  requestsAtom: null as Atom.Writable<StreamResult> | null,
  respond: vi.fn(),
  renderHtmlPdf: vi.fn(),
  openFile: vi.fn(),
  openScient: vi.fn(),
  httpBaseUrl: "http://localhost:3773",
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { renderHtmlPdf: mocks.renderHtmlPdf },
}));
vi.mock("./documentPagePdf", () => ({ renderDocumentPagePdfForHost: vi.fn() }));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => mocks } }));
vi.mock("~/assets/assetUrls", () => ({
  resolveAssetUrl: (base: string, path: string) => `${base}${path}`,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "documents-host" }] }),
  useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl,
}));
vi.mock("~/state/scientDocumentPdf", () => ({
  scientDocumentPdfEnvironment: {
    hostRequests: () => mocks.requestsAtom!,
    respondToHost: "respondToHost",
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.respond }));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "mounted-test" }));
import { ScientDocumentHosts } from "./documentHost";

const environmentId = EnvironmentId.make("documents-host");
const threadId = ThreadId.make("background-build");
const artifact = {
  title: "Study",
  sourceUrl: "http://localhost:3773/assets/study.html",
  profile: "source-authored",
  media: "print",
  warnings: [],
  sourceSignals: [],
  blockedRequestCount: 0,
  data: new Uint8Array([37, 80, 68, 70]),
};
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
const latexRequest = (requestId: string): ScientDocumentHostRequest => ({
  requestId,
  threadId,
  timeoutMs: 15_000,
  operation: "documentLatexPresent",
  input: { rootSourcePath: `papers/${requestId}.tex` },
});
const renderRequest = (requestId: string): ScientDocumentHostRequest => ({
  requestId,
  threadId,
  timeoutMs: 15_000,
  operation: "documentPdfRender",
  input: { assetRelativeUrl: "/assets/study.html" },
});
const emit = (event: ScientDocumentHostStreamEvent) =>
  registry.set(mocks.requestsAtom!, AsyncResult.success(event));
const mount = async () => {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <ScientDocumentHosts />
      </RegistryContext.Provider>,
    );
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: {} });
  registry = AtomRegistry.make();
  mocks.requestsAtom = Atom.make<StreamResult>(AsyncResult.initial(false)).pipe(Atom.keepAlive);
  mocks.httpBaseUrl = "http://localhost:3773";
  mocks.respond.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  mocks.renderHtmlPdf.mockReset().mockResolvedValue(artifact);
  mocks.openFile.mockReset();
  mocks.openScient.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("mounted controlled document host", () => {
  it("consumes both requests emitted before React can commit another render", async () => {
    await mount();
    await act(async () => {
      emit({ type: "connected", connectionId: "connection-1" });
      // No render or asynchronous boundary occurs between these two stream emissions.
      emit({ type: "request", connectionId: "connection-1", request: latexRequest("first") });
      emit({ type: "request", connectionId: "connection-1", request: latexRequest("second") });
    });
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(2));
    expect(mocks.openFile.mock.calls.map((call) => call[1])).toEqual([
      "papers/first.tex",
      "papers/second.tex",
    ]);
    expect(mocks.openFile.mock.calls.map((call) => call[0])).toEqual([
      { environmentId, threadId },
      { environmentId, threadId },
    ]);
    expect(mocks.respond.mock.calls.map(([response]) => response)).toEqual([
      {
        environmentId,
        input: {
          clientId: "scient-documents-mounted-test",
          connectionId: "connection-1",
          requestId: "first",
          ok: true,
          result: {},
        },
      },
      {
        environmentId,
        input: {
          clientId: "scient-documents-mounted-test",
          connectionId: "connection-1",
          requestId: "second",
          ok: true,
          result: {},
        },
      },
    ]);
  });

  it("consumes the pending initial request and updates its environment URL without reconnecting", async () => {
    emit({ type: "request", connectionId: "connection-1", request: renderRequest("cached") });
    await mount();
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(1));
    mocks.httpBaseUrl = "http://localhost:4884";
    await act(async () => {
      renderer!.update(
        <RegistryContext.Provider value={registry}>
          <ScientDocumentHosts />
        </RegistryContext.Provider>,
      );
    });
    await act(async () => {
      emit({ type: "request", connectionId: "connection-1", request: renderRequest("fresh") });
    });
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(2));
    expect(mocks.renderHtmlPdf.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:3773/assets/study.html",
      "http://localhost:4884/assets/study.html",
    ]);
  });

  it("suppresses a completed old render and old-stream presentation after connection replacement", async () => {
    let finish: ((value: typeof artifact) => void) | undefined;
    mocks.renderHtmlPdf.mockImplementationOnce(
      () =>
        new Promise<typeof artifact>((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await act(async () => {
      emit({ type: "connected", connectionId: "old-connection" });
      emit({
        type: "request",
        connectionId: "old-connection",
        request: renderRequest("old-print"),
      });
    });
    expect(mocks.renderHtmlPdf).toHaveBeenCalledTimes(1);
    await act(async () => {
      emit({ type: "connected", connectionId: "new-connection" });
      emit({ type: "request", connectionId: "old-connection", request: latexRequest("stale") });
      emit({ type: "request", connectionId: "new-connection", request: latexRequest("current") });
      finish!(artifact);
    });
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(1));
    expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(
      { environmentId, threadId },
      "papers/current.tex",
      undefined,
      { latexPreviewMode: "split" },
    );
    expect(mocks.respond).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        clientId: "scient-documents-mounted-test",
        connectionId: "new-connection",
        requestId: "current",
        ok: true,
        result: {},
      },
    });
  });

  it("does not return an in-flight renderer receipt after the host unmounts", async () => {
    let finish: ((value: typeof artifact) => void) | undefined;
    mocks.renderHtmlPdf.mockImplementationOnce(
      () =>
        new Promise<typeof artifact>((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await act(async () => {
      emit({ type: "request", connectionId: "connection-1", request: renderRequest("printing") });
    });
    expect(mocks.renderHtmlPdf).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.unmount();
    });
    renderer = undefined;
    // IdleTTL zero finalizes the atom when React releases its lifetime mount.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await act(async () => {
      finish!(artifact);
    });
    expect(mocks.respond).not.toHaveBeenCalled();
  });
});
