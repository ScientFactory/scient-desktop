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
  importScientSourcesFile: vi.fn(),
  advanceSourcesImport: vi.fn(),
  uploadLocalSourcePdf: vi.fn(),
  beginLocalSourcesImport: vi.fn(),
  discardLocalSourcePdfs: vi.fn(),
}));

vi.mock("./client", () => ({
  readScientSources: mocks.readScientSources,
  readScientSource: vi.fn(),
  advanceSourcesImport: mocks.advanceSourcesImport,
  importScientSourcesFile: mocks.importScientSourcesFile,
  beginLocalSourcesImport: mocks.beginLocalSourcesImport,
  beginZoteroItemsImport: vi.fn(),
  beginZoteroScopeImport: vi.fn(),
  cancelSourcesImport: vi.fn(),
  discardLocalSourcePdfs: mocks.discardLocalSourcePdfs,
  preflightZoteroItems: mocks.preflightZoteroItems,
  refreshScientSourceMetadata: vi.fn(),
  removeScientSource: vi.fn(),
  retrySourcesImport: vi.fn(),
  updateScientSourceNote: vi.fn(),
  readZoteroLibrary: vi.fn(),
  readZoteroCollections: vi.fn(),
  readZoteroStatus: vi.fn(),
  uploadLocalSourcePdf: mocks.uploadLocalSourcePdf,
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
  clearOperationSummary: () => void;
  preflight: ScientSourcesPreflightResult | null;
  busy: boolean;
  importing: boolean;
  overviewLoading: boolean;
  error: string | null;
  overviewError: string | null;
  reloadOverview: () => Promise<unknown>;
  previewImport: (itemKeys: ReadonlyArray<string>) => Promise<unknown>;
  importReferenceFile: ReturnType<typeof useScientSources>["importReferenceFile"];
  uploadLocalFiles: ReturnType<typeof useScientSources>["uploadLocalFiles"];
  operation: ReturnType<typeof useScientSources>["operation"];
  selectScope: ReturnType<typeof useScientSources>["selectScope"];
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
  mocks.importScientSourcesFile.mockReset();
  mocks.advanceSourcesImport.mockReset();
}

describe("useScientSources mounted behavior", () => {
  it("runs a reference file import to the end and counts entries already in the Library", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    mocks.readScientSources.mockResolvedValue(overviewWith([]));
    const operation = (state: "pending" | "imported", running: boolean) => ({
      formatVersion: 1 as const,
      operationId: "operation-file",
      projectId: "project-1",
      adapter: "file" as const,
      actor: "user" as const,
      intake: "file" as const,
      state: running ? ("running" as const) : ("completed" as const),
      createdAt: "2026-11-10T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
      items: [
        {
          itemKey: "file_a",
          state,
          sourceId: state === "imported" ? "source-a" : null,
          message: null,
        },
      ],
    });
    const report = {
      format: "bibtex" as const,
      entryCount: 3,
      importCount: 1,
      alreadyInLibrary: 2,
      remaining: 0,
      unreadableCount: 0,
      unreadable: [],
      notKept: [],
      withoutCitationKey: 0,
    };
    mocks.importScientSourcesFile.mockResolvedValue({
      operation: operation("pending", true),
      report,
    });
    mocks.advanceSourcesImport.mockResolvedValue(operation("imported", false));

    await withMountedHook(_fixture, async (probe) => {
      let result: Awaited<ReturnType<HookProbe["importReferenceFile"]>> = null;
      await act(async () => {
        result = await probe.current.importReferenceFile(
          new File(["@article{a, title={A}}"], "library.bib"),
        );
      });
      expect(mocks.advanceSourcesImport).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        report,
        outcome: { kind: "imported", counts: { imported: 1, alreadyPresent: 2 } },
      });
      expect(probe.current.operation?.state).toBe("completed");
      expect(probe.current.busy).toBe(false);
    });
  });

  it("lists the Library view on request and imports from it without pinning here", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const scoped = (listed: "project" | "library", sourceIds: ReadonlyArray<string>) => ({
      ...overviewWith(sourceIds),
      scopes: { listed, project: 1, library: 2 },
    });
    mocks.readScientSources.mockImplementation(
      async (_environment: EnvironmentId, _root: string, scope?: "library") =>
        scope === "library"
          ? scoped("library", ["pinned", "other"])
          : scoped("project", ["pinned"]),
    );
    mocks.importScientSourcesFile.mockResolvedValue({
      operation: null,
      report: {
        format: "bibtex" as const,
        entryCount: 0,
        importCount: 0,
        alreadyInLibrary: 0,
        remaining: 0,
        unreadableCount: 0,
        unreadable: [],
        notKept: [],
        withoutCitationKey: 0,
      },
    });

    await withMountedHook(_fixture, async (probe) => {
      expect(mocks.readScientSources).toHaveBeenLastCalledWith(
        environmentId,
        "/project",
        undefined,
        undefined,
      );
      await act(async () => {
        await probe.current.importReferenceFile(new File([""], "here.bib"));
      });
      expect(mocks.importScientSourcesFile.mock.calls[0]?.[1]).not.toHaveProperty("pin");

      await act(async () => {
        await probe.current.selectScope("library");
      });
      expect(mocks.readScientSources).toHaveBeenLastCalledWith(
        environmentId,
        "/project",
        "library",
        undefined,
      );
      expect(probe.current.overview?.scopes?.listed).toBe("library");
      expect(probe.current.overview?.records).toHaveLength(2);
      await act(async () => {
        await probe.current.importReferenceFile(new File([""], "library.bib"));
      });
      expect(mocks.importScientSourcesFile.mock.calls[1]?.[1]).toMatchObject({ pin: false });
    });
  });

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

  it("sends the revision it holds and keeps its rows when the list is unchanged", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const full = {
      ...overviewWith(["one", "two"]),
      revision: "rev-1",
      organization: { collections: [], savedSearches: [] },
    };
    mocks.readScientSources
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce({ ...overviewWith([]), revision: "rev-1", unchanged: true })
      .mockResolvedValueOnce({ ...overviewWith(["three"]), revision: "rev-2" });

    await withMountedHook(_fixture, async (probe) => {
      expect(mocks.readScientSources).toHaveBeenLastCalledWith(
        environmentId,
        "/project",
        undefined,
        undefined,
      );
      await act(async () => {
        await probe.current.reloadOverview();
      });
      expect(mocks.readScientSources).toHaveBeenLastCalledWith(
        environmentId,
        "/project",
        undefined,
        "rev-1",
      );
      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual([
        "one",
        "two",
      ]);
      expect(probe.current.overview?.organization).toEqual(full.organization);
      expect(probe.current.overview).not.toHaveProperty("unchanged");

      // A new revision replaces the rows.
      await act(async () => {
        await probe.current.reloadOverview();
      });
      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual(["three"]);
    });
  });

  it("dismisses a finished import summary", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    mocks.readScientSources.mockResolvedValue({
      ...overviewWith(["one"]),
      activeOperation: {
        formatVersion: 1,
        operationId: "operation-1",
        projectId: "project-1",
        adapter: "local-files",
        actor: "user",
        intake: "local-pdf",
        state: "completed",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
        items: [{ itemKey: "one", state: "imported", sourceId: "one", message: null }],
      },
    });

    await withMountedHook(_fixture, async (probe) => {
      expect(probe.current.operation?.operationId).toBe("operation-1");
      await act(async () => probe.current.clearOperationSummary());
      expect(probe.current.operation).toBeNull();
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

  it("sends the PDF of a paper already here to the import, to be added to it", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);
    mocks.readScientSources.mockResolvedValue(overviewWith([]));
    const staged = (sourceKey: string, kind: "new" | "same-identifier") => ({
      item: {
        candidate: {
          sourceKey,
          type: "preprint",
          customType: null,
          title: `Paper ${sourceKey}`,
          creators: [],
          issuedRaw: null,
          issuedYear: 2017,
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
          pdfFileName: `${sourceKey}.pdf`,
          pdfAvailable: true,
          pdfAttachmentCount: 1,
        },
        duplicate: {
          kind,
          matchingSourceIds: kind === "new" ? [] : ["source-filed"],
          reason: kind,
        },
        metadataDiagnostics: [],
      },
    });
    mocks.uploadLocalSourcePdf
      .mockReset()
      .mockResolvedValueOnce(staged("fresh", "new"))
      .mockResolvedValueOnce(staged("filed", "same-identifier"));
    const operation = {
      formatVersion: 1,
      operationId: "operation-pdf",
      projectId: "project-1",
      adapter: "local-files",
      actor: "user",
      intake: "local-pdf",
      state: "completed",
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
      items: [],
    };
    mocks.beginLocalSourcesImport.mockReset().mockResolvedValue(operation);
    mocks.discardLocalSourcePdfs.mockReset().mockResolvedValue({ discarded: 0 });

    await withMountedHook(_fixture, async (probe) => {
      await act(async () => {
        await probe.current.uploadLocalFiles([
          new File(["%PDF-1.7"], "fresh.pdf", { type: "application/pdf" }),
          new File(["%PDF-1.7"], "filed.pdf", { type: "application/pdf" }),
        ]);
      });
      expect(mocks.beginLocalSourcesImport).toHaveBeenCalledWith(
        environmentId,
        expect.objectContaining({ itemKeys: ["fresh", "filed"] }),
      );
      expect(mocks.discardLocalSourcePdfs).not.toHaveBeenCalled();
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

  it("keeps the current project's held list when a late reply of the project left arrives", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const oldReload = Promise.withResolvers<ScientSourcesOverviewResult>();
    mocks.readScientSources
      .mockResolvedValueOnce({ ...overviewWith(["project-a"]), revision: "rev-a" })
      .mockImplementationOnce(() => oldReload.promise)
      .mockResolvedValueOnce({ ...overviewWith(["project-b"]), revision: "rev-b" })
      .mockResolvedValueOnce({ ...overviewWith([]), revision: "rev-b", unchanged: true });

    await withMountedHook(_fixture, async (probe, controls) => {
      let pending: Promise<unknown> | undefined;
      await act(async () => {
        pending = probe.current.reloadOverview();
        await Promise.resolve();
      });
      await controls.rerender("/project-b");
      await act(async () => {
        oldReload.resolve({ ...overviewWith(["stale-project-a"]), revision: "rev-a2" });
        await pending;
      });
      await act(async () => {
        await probe.current.reloadOverview();
      });
      expect(mocks.readScientSources).toHaveBeenLastCalledWith(
        environmentId,
        "/project-b",
        undefined,
        "rev-b",
      );
      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual([
        "project-b",
      ]);
    });
  });

  it("reads the list without marking work busy, and a read cannot end an import's busy", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const read = Promise.withResolvers<ScientSourcesOverviewResult>();
    const preflight = Promise.withResolvers<ScientSourcesPreflightResult>();
    mocks.readScientSources
      .mockResolvedValueOnce(overviewWith(["one"]))
      .mockImplementationOnce(() => read.promise)
      .mockResolvedValue(overviewWith(["one"]));
    mocks.preflightZoteroItems.mockImplementationOnce(() => preflight.promise);

    await withMountedHook(_fixture, async (probe) => {
      let reload: Promise<unknown> | undefined;
      await act(async () => {
        reload = probe.current.selectScope("library");
      });
      expect(probe.current.overviewLoading).toBe(true);
      expect(probe.current.busy).toBe(false);
      expect(probe.current.importing).toBe(false);

      let preview: Promise<unknown> | undefined;
      await act(async () => {
        preview = probe.current.previewImport(["zotero-item-1"]);
      });
      expect(probe.current.importing).toBe(true);
      await act(async () => {
        read.resolve(overviewWith(["one", "two"]));
        await reload;
      });
      expect(probe.current.overviewLoading).toBe(false);
      expect(probe.current.importing).toBe(true);
      expect(probe.current.busy).toBe(true);

      await act(async () => {
        preflight.resolve({ items: [] });
        await preview;
      });
      expect(probe.current.importing).toBe(false);
      expect(probe.current.busy).toBe(false);
    });
  });

  it("keeps an action's error when a later read of the list fails", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    mocks.readScientSources
      .mockResolvedValueOnce(overviewWith(["one"]))
      .mockRejectedValueOnce(new Error("The server did not answer."));
    mocks.preflightZoteroItems.mockRejectedValueOnce(new Error("Zotero is closed."));

    await withMountedHook(_fixture, async (probe) => {
      await act(async () => {
        await probe.current.previewImport(["zotero-item-1"]);
      });
      const actionError = probe.current.error;
      expect(actionError).not.toBeNull();
      await act(async () => {
        await probe.current.reloadOverview();
      });
      expect(probe.current.error).toBe(actionError);
      expect(probe.current.overviewError).not.toBeNull();
      expect(probe.current.overviewLoading).toBe(false);
      // The list on screen stays; only its freshness is in doubt.
      expect(probe.current.overview?.records.map((record) => record.sourceId)).toEqual(["one"]);
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
