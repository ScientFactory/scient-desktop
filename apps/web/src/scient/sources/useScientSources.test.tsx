// The repo has no jsdom/@testing-library/react (default test env is `node`),
// so the hook is exercised through `react-dom/client` with the minimal DOM
// stub from PreviewView's test. These tests mount the real hook with mocked
// client functions: they exist to catch render-timing defects in the hook
// itself — dispatch/commit ordering, token capture, and effect-driven loads —
// which reducer-only tests cannot observe.
import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useScientSources } from "./useScientSources";

const mocks = vi.hoisted(() => ({
  readScientSources: vi.fn(),
}));

vi.mock("./client", () => ({
  readScientSources: mocks.readScientSources,
  readScientSource: vi.fn(),
  advanceSourcesImport: vi.fn(),
  approveScientSource: vi.fn(),
  beginLocalSourcesImport: vi.fn(),
  beginZoteroItemsImport: vi.fn(),
  beginZoteroScopeImport: vi.fn(),
  cancelSourcesImport: vi.fn(),
  discardLocalSourcePdfs: vi.fn(),
  preflightZoteroItems: vi.fn(),
  refreshScientSourceMetadata: vi.fn(),
  removeScientSource: vi.fn(),
  retrySourcesImport: vi.fn(),
  updateScientSourceNote: vi.fn(),
  readZoteroLibrary: vi.fn(),
  readZoteroCollections: vi.fn(),
  readZoteroStatus: vi.fn(),
  uploadLocalSourcePdf: vi.fn(),
}));

// ReactDOM needs a host, but this unit suite intentionally has no DOM
// dependency; mirror the PreviewView test's minimal node stub.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = "#element";
    this.tagName = this.nodeName;
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    void name;
    return new TestNode(this.ownerDocument, 1);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode(null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

const environmentId = "environment-1" as EnvironmentId;

function overviewWith(sourceIds: ReadonlyArray<string>): ScientSourcesOverviewResult {
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    activeOperation: null,
    records: sourceIds.map((sourceId) => ({
      sourceId,
      revision: 1,
      type: "article",
      title: `Source ${sourceId}`,
      creators: [],
      issuedYear: 2024,
      identifiers: [],
      containerTitle: null,
      url: null,
      externalReferences: [],
      attachments: [],
      importedAt: "2026-08-13T00:00:00.000Z",
    })),
  };
}

interface HookProbe {
  overview: ScientSourcesOverviewResult | null;
  busy: boolean;
  error: string | null;
  reloadOverview: () => Promise<unknown>;
}

async function withMountedHook(
  run: (probe: { current: HookProbe }) => Promise<void>,
): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  const document = installTestDom();
  const root = createRoot(document.createElement("div") as unknown as Element);
  const probe = { current: { overview: null } as HookProbe };
  let lastError: unknown = null;

  function Harness() {
    try {
      const sources = useScientSources({ environmentId, root: "/project" });
      probe.current = sources;
    } catch (error) {
      lastError = error;
    }
    return null;
  }
  const flush = async () => {
    // The mocked fetch resolves on the microtask queue; drain enough turns
    // for the response dispatch and the render it triggers to settle.
    for (let turn = 0; turn < 10 && probe.current.overview === null; turn += 1) {
      await Promise.resolve();
    }
  };
  try {
    await act(async () => {
      root.render(<Harness />);
      await flush();
    });
    await run(probe);
    expect(lastError).toBeNull();
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  mocks.readScientSources.mockReset();
});

describe("useScientSources mounted behavior", () => {
  it("loads the initial overview into state after mount", async () => {
    mocks.readScientSources.mockResolvedValue(overviewWith(["one", "two"]));

    await withMountedHook(async (probe) => {
      // The context effect fires refreshOverview on mount; its response must
      // land despite the token being captured before any commit.
      expect(mocks.readScientSources).toHaveBeenCalledTimes(1);
      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual([
        "one",
        "two",
      ]);
      expect(probe.current.busy).toBe(false);
      expect(probe.current.error).toBeNull();
    });
  });

  it("keeps a late superseded overview response from overwriting newer state", async () => {
    let releaseFirst: ((value: ScientSourcesOverviewResult) => void) | undefined;
    const firstGate = new Promise<ScientSourcesOverviewResult>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.readScientSources
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValueOnce(overviewWith(["second"]));

    await withMountedHook(async (probe) => {
      // The first request is still pending when a second load starts and
      // completes; the late stale-first response must not overwrite it.
      await act(async () => {
        const reload = probe.current.reloadOverview();
        releaseFirst?.(overviewWith(["stale-first"]));
        await reload;
      });

      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual(["second"]);
    });
  });
});
