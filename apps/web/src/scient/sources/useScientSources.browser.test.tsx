import { render as _fixtureRender, act } from "../../../test/render";
import type {
  EnvironmentId,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { useScientSources } from "./useScientSources";

const mocks = vi.hoisted(() => ({
  readScientSources: vi.fn(),
  preflightZoteroItems: vi.fn(),
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
  preflightZoteroItems: mocks.preflightZoteroItems,
  refreshScientSourceMetadata: vi.fn(),
  removeScientSource: vi.fn(),
  retrySourcesImport: vi.fn(),
  updateScientSourceNote: vi.fn(),
  readZoteroLibrary: vi.fn(),
  readZoteroCollections: vi.fn(),
  readZoteroStatus: vi.fn(),
  uploadLocalSourcePdf: vi.fn(),
}));

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
  preflight: ScientSourcesPreflightResult | null;
  busy: boolean;
  error: string | null;
  reloadOverview: () => Promise<unknown>;
  previewImport: (itemKeys: ReadonlyArray<string>) => Promise<unknown>;
}

async function withMountedHook(
  _fixture: _Fixture,
  run: (
    probe: { current: HookProbe },
    controls: { rerender: (nextRoot: string) => Promise<void> },
  ) => Promise<void>,
): Promise<void> {
  const appRoot = _fixture.stack.use(
    await _fixtureRender(null, { container: document.createElement("div"), router: false }),
  );
  const probe = { current: { overview: null } as HookProbe };

  function Harness(props: { readonly projectRoot: string }) {
    const sources = useScientSources({ environmentId, root: props.projectRoot });
    useEffect(() => {
      probe.current = sources;
    }, [sources]);
    return null;
  }
  const flush = async () => {
    // The mocked fetch resolves on the microtask queue; drain enough turns
    // for the response dispatch and the render it triggers to settle.
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
  };
  try {
    await act(async () => {
      await appRoot.rerender(<Harness projectRoot="/project" />);
      await flush();
    });
    await run(probe, {
      rerender: async (nextRoot) => {
        await act(async () => {
          await appRoot.rerender(<Harness projectRoot={nextRoot} />);
          await flush();
        });
      },
    });
  } finally {
    await act(async () => await appRoot.unmount());
  }
}

async function _setupFixture0(_fixture: _Fixture) {
  mocks.readScientSources.mockReset();
  mocks.preflightZoteroItems.mockReset();
}

describe("useScientSources mounted behavior", () => {
  it("loads the initial overview into state after mount", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    mocks.readScientSources.mockResolvedValue(overviewWith(["one", "two"]));

    await withMountedHook(_fixture, async (probe) => {
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
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    let releaseFirst: ((value: ScientSourcesOverviewResult) => void) | undefined;
    const firstGate = new Promise<ScientSourcesOverviewResult>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.readScientSources
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValueOnce(overviewWith(["second"]));

    await withMountedHook(_fixture, async (probe) => {
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

  it("accepts the first import preflight after the initial context reset", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    mocks.readScientSources.mockResolvedValue(overviewWith([]));
    mocks.preflightZoteroItems.mockResolvedValue({
      items: [
        {
          candidate: {
            sourceKey: "zotero-item-1",
            type: "article",
            title: "A possible duplicate",
            creators: [],
            issuedRaw: null,
            issuedYear: 2024,
            identifiers: [],
            abstract: null,
            containerTitle: null,
            publisher: null,
            volume: null,
            issue: null,
            pages: null,
            language: null,
            url: null,
            tags: [],
            externalReferences: [],
            fieldProvenance: [],
            pdfFileName: null,
            pdfAvailable: false,
            pdfAttachmentCount: 0,
          },
          duplicate: {
            kind: "possible-metadata-match",
            matchingSourceIds: ["source-existing"],
            reason: "Title and year match",
          },
          metadataDiagnostics: [],
        },
      ],
    } satisfies ScientSourcesPreflightResult);

    await withMountedHook(_fixture, async (probe) => {
      let outcome: unknown;
      await act(async () => {
        outcome = await probe.current.previewImport(["zotero-item-1"]);
      });

      expect(outcome).toMatchObject({ kind: "review-required" });
      expect(probe.current.preflight?.items[0]?.candidate.sourceKey).toBe("zotero-item-1");
      expect(probe.current.busy).toBe(false);
    });
  });

  it("rejects a late overview from the previous project context", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    let releaseOldReload: ((value: ScientSourcesOverviewResult) => void) | undefined;
    const oldReloadGate = new Promise<ScientSourcesOverviewResult>((resolve) => {
      releaseOldReload = resolve;
    });
    mocks.readScientSources
      .mockResolvedValueOnce(overviewWith(["project-a"]))
      .mockImplementationOnce(() => oldReloadGate)
      .mockResolvedValueOnce(overviewWith(["project-b"]));

    await withMountedHook(_fixture, async (probe, controls) => {
      let oldReload: Promise<unknown> | undefined;
      await act(async () => {
        oldReload = probe.current.reloadOverview();
        await Promise.resolve();
      });
      await controls.rerender("/project-b");
      await act(async () => {
        releaseOldReload?.(overviewWith(["stale-project-a"]));
        await oldReload;
      });

      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual([
        "project-b",
      ]);
      expect(probe.current.busy).toBe(false);
    });
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
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
