import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { PreviewStaticImageSurfaceDescriptor } from "./previewStaticImageSurface";
import { useClosedViewStore } from "./closedViewStore";
import {
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";
import {
  scientComputeSurface,
  scientEnvironmentFileSurface,
  scientGeneratedPdfSurface,
  scientSourcePdfSurface,
  scientSourcesSurface,
} from "./scient/rightPanel/surfaces";
import type { ComputeContextId } from "./scient/compute/computeContextStore";
import { withoutTransientFileRequests } from "./scient/rightPanel/scientRightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

const generatedPdf = (revision: number) => {
  const source = PdfSourceDescriptor.make({
    _tag: "generated-pdf",
    authority: ArtifactAuthority.make("env-1"),
    logicalDocumentKey: LogicalDocumentKey.make("browser-export:fixture"),
    title: "Fixture export",
    fileName: "Fixture export.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: ArtifactId.make("artifact-1"),
    revisionId: ArtifactRevisionId.make(`revision-${revision}`),
    bindingGeneration: BindingGeneration.make(revision),
    bindingStatus: "current",
    staleReason: null,
    pageCount: revision,
  });
  if (source._tag !== "generated-pdf") throw new Error("expected generated PDF fixture");
  return source;
};

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

const staticImage = (runId: string): PreviewStaticImageSurfaceDescriptor => ({
  surfaceId: "project-a:script.m:figure-001",
  label: "Figure 1",
  fileName: "figure-001.png",
  mediaType: "image/png",
  sourcePath: "script.m",
  resource: {
    _tag: "analysis-artifact",
    projectId: "project-a",
    runId,
    artifactId: "figure-001",
    representationId: "static-png",
  } as PreviewStaticImageSurfaceDescriptor["resource"],
});

describe("Scient right panel surfaces", () => {
  // A malformed persisted entry is dropped instead of crashing the panel store's migration.
  it("preserves a closed inline panel while discarding transient popover visibility", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {},
        threadPanelVisibilityByThreadKey: {
          closed: { inlineOpen: false, popoverOpen: true },
          open: { inlineOpen: true, popoverOpen: true },
          malformed: null,
        },
      }),
    ).toEqual({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {
        closed: { inlineOpen: false, popoverOpen: false },
      },
    });
  });
  it("preserves both parallel v16 surface families when migrating to the combined schema", () => {
    const compute = scientComputeSurface({
      cwd: "/project",
      contextId: "owner-1" as ComputeContextId,
    });
    const device = {
      id: "device:host:phone",
      kind: "device",
      target: { hostId: "host", deviceId: "phone", name: "Phone", platform: "ios" },
    } as const;
    const state = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: compute.id,
          surfaces: [compute, device],
        },
      },
    });
    expect(state.byThreadKey["env-1:thread-A"]?.surfaces).toEqual([compute, device]);
    expect(state.byThreadKey["env-1:thread-A"]?.activeSurfaceId).toBe(compute.id);
  });

  it("migrates an active revision-keyed PDF tab to stable artifact identity", () => {
    const source = generatedPdf(1);
    const legacyId = "scient:generated-pdf:env-1:artifact-1:revision-1";

    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: legacyId,
            surfaces: [{ id: legacyId, kind: "scient", module: "generated-pdf", source }],
          },
        },
      }),
    ).toEqual({
      threadPanelVisibilityByThreadKey: {},
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "scient:generated-pdf:env-1:artifact-1",
          surfaces: [scientGeneratedPdfSurface(source)],
        },
      },
    });
  });

  it("moves a renamed file's tab in place, keeping its state only when asked", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "notes/other.md");
    store.openFile(refA, "notes/a.md", 12);
    store.renameFileSurface(refA, "notes/a.md", "notes/b.md", { keepState: true });
    let state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "file:notes/other.md",
      "file:notes/b.md",
    ]);
    expect(state.activeSurfaceId).toBe("file:notes/b.md");
    expect(state.surfaces[1]).toMatchObject({
      relativePath: "notes/b.md",
      revealLine: 12,
      revealRequestId: 1,
    });
    store.renameFileSurface(refA, "notes/b.md", "notes/c.md");
    state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces[1]).toMatchObject({
      id: "file:notes/c.md",
      revealLine: null,
      revealRequestId: 0,
    });
  });

  it("upgrades saved file surfaces with neutral reveal state", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [
              {
                id: "file:src/index.ts",
                kind: "file",
                relativePath: "src/index.ts",
                htmlPresentationRequest: { id: 8, mode: "source" },
                latexPresentationRequest: { id: 9, mode: "split" },
              },
            ],
          },
        },
      }),
    ).toEqual({
      threadPanelVisibilityByThreadKey: {},
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    });
  });

  it("drops legacy source-PDF surfaces without a source identity during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "scient:sources",
            surfaces: [
              { id: "scient:sources", kind: "scient", module: "sources" },
              {
                id: "scient:source-pdf:legacy-id",
                kind: "scient",
                module: "source-pdf",
                attachmentId: "pdf 1",
                fileName: "Paper.pdf",
              },
              { id: "scient:unknown", kind: "scient", module: "unknown" },
            ],
          },
        },
      }),
    ).toEqual({
      threadPanelVisibilityByThreadKey: {},
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "scient:sources",
          surfaces: [{ id: "scient:sources", kind: "scient", module: "sources" }],
        },
      },
    });
  });

  it("keeps valid direct-image surfaces and drops malformed ones during migration", () => {
    const artifact = staticImage("run-1");
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "scient:artifact:legacy",
            surfaces: [
              {
                id: "scient:artifact:legacy",
                kind: "scient",
                module: "artifact",
                artifact,
              },
              {
                id: "scient:artifact:broken",
                kind: "scient",
                module: "artifact",
                artifact: { ...artifact, resource: { _tag: "not-an-asset" } },
              },
            ],
          },
        },
      }),
    ).toEqual({
      threadPanelVisibilityByThreadKey: {},
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: `scient:artifact:${artifact.surfaceId}`,
          surfaces: [
            {
              id: `scient:artifact:${artifact.surfaceId}`,
              kind: "scient",
              module: "artifact",
              artifact,
            },
          ],
        },
      },
    });
  });

  it("refreshes an existing Scient file surface when its reveal target changes", () => {
    useRightPanelStore
      .getState()
      .openScient(refA, scientEnvironmentFileSurface({ path: "/tmp/results.tsx", line: 12 }));
    useRightPanelStore
      .getState()
      .openScient(refA, scientEnvironmentFileSurface({ path: "/tmp/results.tsx", line: 48 }));

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "scient:file:%2Ftmp%2Fresults.tsx",
      surfaces: [
        {
          id: "scient:file:%2Ftmp%2Fresults.tsx",
          kind: "scient",
          module: "file",
          path: "/tmp/results.tsx",
          line: 48,
        },
      ],
    });
  });

  it("opens a source PDF beside the Sources library", () => {
    useRightPanelStore.getState().openScient(refA, scientSourcesSurface());
    useRightPanelStore.getState().openScient(
      refA,
      scientSourcePdfSurface({
        sourceId: "source_123",
        attachmentId: "pdf_123",
        fileName: "Paper.pdf",
      }),
    );

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "scient:source-pdf:source_123:pdf_123",
      surfaces: [
        { id: "scient:sources", kind: "scient", module: "sources" },
        {
          id: "scient:source-pdf:source_123:pdf_123",
          kind: "scient",
          module: "source-pdf",
          sourceId: "source_123",
          attachmentId: "pdf_123",
          fileName: "Paper.pdf",
        },
      ],
    });
  });

  it("updates an open direct-image surface to the latest resource without changing its tab", () => {
    const first = staticImage("run-1");
    const updated = {
      ...staticImage("run-2"),
      reloadKey: "revision-2",
      statusLabel: "Previous figure",
    };
    useRightPanelStore.getState().openScientArtifact(refA, first);
    useRightPanelStore.getState().updateScientArtifact(refA, updated);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: `scient:artifact:${first.surfaceId}`,
      surfaces: [
        {
          id: `scient:artifact:${first.surfaceId}`,
          kind: "scient",
          module: "artifact",
          artifact: updated,
        },
      ],
    });
  });

  it("does not create a direct-image surface during a passive update", () => {
    useRightPanelStore.getState().updateScientArtifact(refA, staticImage("run-2"));
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  const completedDiff = { kind: "diff", turnId: RunId.make("turn-1") } as const;
  it.each([
    {
      choice: "sources",
      choose: () => useRightPanelStore.getState().openScient(refA, scientSourcesSurface()),
    },
    {
      choice: "artifact",
      choose: () => useRightPanelStore.getState().openScientArtifact(refA, staticImage("manual")),
    },
  ])("keeps a later Scient $choice choice when automatic requests arrive", ({ choose }) => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    const revision = store.getUserActionRevision(refA);
    choose();
    const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

    expect(store.openProactive(refA, completedDiff, revision)).toBe(false);
    const { isOpen, activeSurfaceId, surfaces } = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      refA,
    );
    expect({ isOpen, activeSurfaceId, surfaces }).toEqual({
      isOpen: chosen.isOpen,
      activeSurfaceId: chosen.activeSurfaceId,
      surfaces: chosen.surfaces,
    });
  });

  it.each([
    {
      kind: "workspace file",
      surfaceId: "file:src/index.ts",
      open: () => useRightPanelStore.getState().openFile(refA, "src/index.ts"),
    },
    {
      kind: "attachment",
      surfaceId: "attachment:report",
      open: () =>
        useRightPanelStore.getState().openAttachment(refA, {
          type: "file",
          id: "report",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
        }),
    },
  ])("replaces a dragged explorer with its $kind in the same slot", ({ surfaceId, open }) => {
    const store = useRightPanelStore.getState();
    store.openTerminal(refA, "term-1");
    store.openBrowser(refA, "tab-a");
    store.open(refA, "diff");
    store.open(refA, "files");
    const revision = store.getUserActionRevision(refA);
    store.moveSurface(refA, "files", 1);
    expect(store.getUserActionRevision(refA)).toBe(revision);

    open();

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "terminal:term-1",
      surfaceId,
      "browser:tab-a",
      "diff",
    ]);
    expect(state.activeSurfaceId).toBe(surfaceId);
    expect(store.getUserActionRevision(refA)).toBe(revision + 1);
  });

  it("keeps a renamed file's tab in place under its new path", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "a.md");
    store.openFile(refA, "draft.tex");
    store.openFile(refA, "z.md");
    store.openFile(refA, "draft.tex");
    store.renameFileSurface(refA, "draft.tex", "paper.tex");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "file:a.md",
      "file:paper.tex",
      "file:z.md",
    ]);
    expect(state.activeSurfaceId).toBe("file:paper.tex");
    // A tab already open on the new path takes over.
    useRightPanelStore.getState().renameFileSurface(refA, "a.md", "z.md");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:paper.tex", "file:z.md"]);
  });

  it("retains an explicitly selected LaTeX root with the navigated source", () => {
    useRightPanelStore
      .getState()
      .openFile(refA, "chapters/results.tex", 18, { latexRootRelativePath: "paper/main.tex" });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([
      {
        id: "file:chapters/results.tex",
        kind: "file",
        relativePath: "chapters/results.tex",
        revealLine: 18,
        revealRequestId: 1,
        latexRootRelativePath: "paper/main.tex",
      },
    ]);
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:chapters/results.tex",
            surfaces: [
              {
                id: "file:chapters/results.tex",
                kind: "file",
                relativePath: "chapters/results.tex",
                revealLine: 18,
                revealRequestId: 1,
                latexRootRelativePath: "paper/main.tex",
              },
            ],
          },
        },
      }).byThreadKey["env-1:thread-A"]?.surfaces,
    ).toMatchObject([{ latexRootRelativePath: "paper/main.tex" }]);
  });

  it("does not replay compiled-source line coordinates after restoring a file tab", () => {
    useRightPanelStore.getState().openFile(refA, "chapters/results.tex", 18, {
      latexRootRelativePath: "paper/main.tex",
      latexSourceRevision: `sha256:${"a".repeat(64)}`,
    });
    const current = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    const serialized = {
      byThreadKey: {
        "env-1:thread-A": {
          ...current,
          surfaces: current.surfaces.map(withoutTransientFileRequests),
        },
      },
    };
    const restored = migratePersistedRightPanelState(serialized).byThreadKey["env-1:thread-A"];
    expect(restored?.surfaces[0]).toMatchObject({
      kind: "file",
      relativePath: "chapters/results.tex",
      revealLine: null,
    });
    expect(restored?.surfaces[0]).not.toHaveProperty("latexSourceReveal");
  });

  it("drops invalid persisted LaTeX roots during migration", () => {
    for (const invalidRoot of [
      "../outside.tex",
      "C:/outside.tex",
      "C:relative.tex",
      String.raw`\\server\share\root.tex`,
    ]) {
      const migrated = migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:chapter.tex",
            surfaces: [
              {
                id: "file:chapter.tex",
                kind: "file",
                relativePath: "chapter.tex",
                revealLine: null,
                revealRequestId: 1,
                latexRootRelativePath: invalidRoot,
              },
            ],
          },
        },
      });

      expect(migrated.byThreadKey["env-1:thread-A"]?.surfaces[0]).not.toHaveProperty(
        "latexRootRelativePath",
      );
    }
  });

  it("carries and consumes a one-shot LaTeX Split presentation request", () => {
    useRightPanelStore.getState().openFile(refA, "sections/results.tex", undefined, {
      latexPreviewMode: "split",
      latexRootRelativePath: "main.tex",
    });

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:sections/results.tex",
      surfaces: [
        {
          id: "file:sections/results.tex",
          kind: "file",
          relativePath: "sections/results.tex",
          revealLine: null,
          revealRequestId: 1,
          latexPresentationRequest: { id: 1, mode: "split" },
          latexRootRelativePath: "main.tex",
        },
      ],
    });

    useRightPanelStore.getState().openFile(refA, "sections/results.tex", undefined, {
      latexPreviewMode: "split",
      latexRootRelativePath: "main.tex",
    });

    useRightPanelStore.getState().consumeLatexPresentationRequest(refA, "sections/results.tex", 1);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:sections/results.tex",
      surfaces: [
        {
          id: "file:sections/results.tex",
          kind: "file",
          relativePath: "sections/results.tex",
          revealLine: null,
          revealRequestId: 2,
          latexPresentationRequest: { id: 2, mode: "split" },
          latexRootRelativePath: "main.tex",
        },
      ],
    });

    useRightPanelStore.getState().consumeLatexPresentationRequest(refA, "sections/results.tex", 2);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:sections/results.tex",
      surfaces: [
        {
          id: "file:sections/results.tex",
          kind: "file",
          relativePath: "sections/results.tex",
          revealLine: null,
          revealRequestId: 2,
          latexRootRelativePath: "main.tex",
        },
      ],
    });
  });

  it("keeps an explicit HTML source request on its file tab until it is handled", () => {
    useRightPanelStore
      .getState()
      .openFile(refA, "report.html", undefined, { htmlPreviewMode: "source" });

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:report.html",
      surfaces: [
        {
          id: "file:report.html",
          kind: "file",
          relativePath: "report.html",
          revealLine: null,
          revealRequestId: 1,
          htmlPresentationRequest: { id: 1, mode: "source" },
        },
      ],
    });

    useRightPanelStore.getState().consumeHtmlPresentationRequest(refA, "report.html", 1);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([
      {
        id: "file:report.html",
        kind: "file",
        relativePath: "report.html",
        revealLine: null,
        revealRequestId: 1,
      },
    ]);

    useRightPanelStore
      .getState()
      .openFile(refA, "report.html", undefined, { htmlPreviewMode: "source" });
    useRightPanelStore.getState().openFile(refA, "report.html");

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([
      {
        id: "file:report.html",
        kind: "file",
        relativePath: "report.html",
        revealLine: null,
        revealRequestId: 3,
      },
    ]);
  });

  it("keeps file surfaces when an environment workspace is available", () => {
    useRightPanelStore.getState().openFile(refA, "paper.pdf");
    useRightPanelStore.getState().open(refA, "agents");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, true);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [
        {
          id: "file:paper.pdf",
          kind: "file",
          relativePath: "paper.pdf",
          revealLine: null,
          revealRequestId: 1,
        },
        { id: "agents", kind: "agents" },
      ],
    });
  });

  it("updates an open generated PDF revision without stealing focus", () => {
    useRightPanelStore.getState().openScient(refA, scientGeneratedPdfSurface(generatedPdf(1)));
    useRightPanelStore.getState().openBrowser(refA, "tab-a");

    useRightPanelStore
      .getState()
      .updateScientGeneratedPdf(refA, scientGeneratedPdfSurface(generatedPdf(2)));

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("browser:tab-a");
    expect(state.surfaces.filter((surface) => surface.kind === "scient")).toEqual([
      scientGeneratedPdfSurface(generatedPdf(2)),
    ]);
  });

  it("restores one sanitized thread state without changing another thread", () => {
    useRightPanelStore.getState().openFile(refA, "origin.ts");
    useRightPanelStore.getState().openFile(refB, "untouched.ts");

    useRightPanelStore.getState().restoreThreadState(refA, {
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces,
    ).toEqual([
      {
        id: "file:untouched.ts",
        kind: "file",
        relativePath: "untouched.ts",
        revealLine: null,
        revealRequestId: 1,
      },
    ]);
  });

  it("keeps a new-browser placeholder until a real browser tab exists", () => {
    useRightPanelStore.getState().openBrowser(refA, null);
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, []);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "browser:new",
      kind: "preview",
      resourceId: null,
    });

    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-a"]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }]);
  });

  it.each(["creation-first", "snapshot-first"])(
    "replaces a dragged browser placeholder in the same slot with %s delivery",
    (delivery) => {
      const store = useRightPanelStore.getState();
      store.openTerminal(refA, "term-1");
      store.openFile(refA, "README.md");
      store.open(refA, "diff");
      store.openBrowser(refA, null);
      const revision = store.getUserActionRevision(refA);
      store.moveSurface(refA, "browser:new", 1);
      expect(store.getUserActionRevision(refA)).toBe(revision);
      if (delivery === "snapshot-first") {
        store.reconcileBrowserSurfaces(refA, ["tab-a", "tab-b"]);
        expect(store.getUserActionRevision(refA)).toBe(revision);
        expect(
          selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)
            .activeSurfaceId,
        ).toBe("browser:tab-a");
      }

      store.openBrowser(refA, "tab-a");
      store.reconcileBrowserSurfaces(refA, ["tab-a", "tab-b"]);

      const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
      expect(state.surfaces.map((surface) => surface.id)).toEqual([
        "terminal:term-1",
        "browser:tab-a",
        "file:README.md",
        "diff",
        "browser:tab-b",
      ]);
      expect(state.activeSurfaceId).toBe("browser:tab-a");
      expect(store.getUserActionRevision(refA)).toBe(revision + 1);
    },
  );

  it("replaces a browser placeholder from a snapshot without stealing another surface's focus", () => {
    const store = useRightPanelStore.getState();
    store.openTerminal(refA, "term-1");
    store.openBrowser(refA, null);
    store.open(refA, "diff");
    store.moveSurface(refA, "browser:new", 0);
    const revision = store.getUserActionRevision(refA);

    store.reconcileBrowserSurfaces(refA, ["tab-a"]);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "browser:tab-a",
      "terminal:term-1",
      "diff",
    ]);
    expect(state.activeSurfaceId).toBe("diff");
    expect(store.getUserActionRevision(refA)).toBe(revision);
  });

  it.each(["browser", "file"])(
    "keeps an already-open %s destination in place when removing its dragged placeholder",
    (kind) => {
      const store = useRightPanelStore.getState();
      const destinationId = kind === "browser" ? "browser:tab-a" : "file:README.md";
      if (kind === "browser") store.openBrowser(refA, "tab-a");
      else store.openFile(refA, "README.md");
      store.openTerminal(refA, "term-1");
      store.open(refA, "diff");
      if (kind === "browser") store.openBrowser(refA, null);
      else store.open(refA, "files");
      store.moveSurface(refA, kind === "browser" ? "browser:new" : "files", 1);

      if (kind === "browser") store.openBrowser(refA, "tab-a");
      else store.openFile(refA, "README.md");

      const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
      expect(state.surfaces.map((surface) => surface.id)).toEqual([
        destinationId,
        "terminal:term-1",
        "diff",
      ]);
      expect(state.activeSurfaceId).toBe(destinationId);
    },
  );
});
