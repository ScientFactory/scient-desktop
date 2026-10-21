import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { createTestCheckpointStore } from "~/scient/markdownEditor/persistence/markdownDraftCheckpointTestkit";
import type * as MarkdownCheckpointModule from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import { sha256 } from "@noble/hashes/sha2";
import {
  EnvironmentId,
  type ProjectReadFileResult,
  type ScientLatexManagedInstallState,
  type ScientLatexToolchainReport,
} from "@t3tools/contracts";
import type { ScientLatexBuildSnapshot } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useSyncExternalStore } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import {
  latexOwnedSourcePatch,
  type LatexEditorSourceSnapshot,
  type LatexVisualEditOutcome,
  type LatexVisualEditRequest,
} from "./latexSourceEditPlan";
import { LATEX_COMPILATION_STORAGE_KEY } from "./latexCompilation";

const {
  notifyLatexBindingChange,
  requestLatexRebuild,
  requestManagedLatexInstall,
  readLatexBuildStatus,
  savePdfCopy,
  sourcePane,
  exportDialog,
  exportMenu,
  visual,
  build,
  sync,
  reader,
} = vi.hoisted(() => ({
  notifyLatexBindingChange: vi.fn(),
  requestLatexRebuild: vi.fn(),
  requestManagedLatexInstall: vi.fn(),
  readLatexBuildStatus: vi.fn(),
  savePdfCopy: vi.fn(),
  sourcePane: { props: null as null | Record<string, unknown> },
  exportDialog: { savedRevision: null as null | (() => Promise<string | null>) },
  exportMenu: {
    props: null as null | {
      wordDisabled?: boolean;
      onWordExport: () => void;
      pdfDisabled?: boolean;
      onPdfExport: () => void;
    },
  },
  visual: {
    props: null as null | {
      onEdit: (request: LatexVisualEditRequest) => LatexVisualEditOutcome;
      sourceSnapshot: LatexEditorSourceSnapshot;
      selectedPending: boolean;
      disabled: boolean;
      source: string;
    },
    // The header row's offer to host the editor's controls, and whether to take it.
    host: null as null | import("../writing/readerBarHost").ReaderBarHost,
    hosts: false,
  },
  build: {
    snapshot: null as unknown,
    toolchain: null as unknown,
    toolchainReport: null as ScientLatexToolchainReport | null,
    canInstallManaged: false,
    managedInstall: null as ScientLatexManagedInstallState | null,
    installRequesting: false,
    version: 0,
    listeners: new Set<() => void>(),
  },
  sync: {
    forward: vi.fn(),
    inverse: vi.fn(),
    pages: vi.fn(async () => ({ _tag: "unavailable", message: "No page anchors." })),
  },
  reader: {
    navigation: null as null | {
      readonly forwardTarget: unknown;
      readonly onInverseSearch?: (point: { page: number; x: number; y: number }) => void;
    },
    host: null as null | import("../writing/readerBarHost").ReaderBarHost,
  },
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  const { AsyncResult } = await import("effect/reactivity");
  return { ...actual, useAtomValue: () => AsyncResult.initial(), useAtomRefresh: () => () => {} };
});
vi.mock("~/components/files/FilePreviewPanel", () => ({
  MarkdownSourceSurface: (props: Record<string, unknown>) => {
    sourcePane.props = props;
    return <div data-testid="source-pane" data-line="3" />;
  },
  useFileLineReveal: () => ({ onPostRender: () => {}, move: () => {} }),
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));
vi.mock("~/scient/markdownEditor/persistence/markdownDraftCheckpoint", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkdownCheckpointModule>();
  return { ...actual, indexedDbMarkdownDrafts: createTestCheckpointStore() };
});
vi.mock("~/scient/pdf/ScientPdfReader", async () => {
  const { useContext } = await import("react");
  const { ReaderBarHostContext } = await import("../writing/readerBarHost");
  return {
    ScientPdfReader: (props: { syncNavigation?: typeof reader.navigation }) => {
      reader.navigation = props.syncNavigation ?? null;
      reader.host = useContext(ReaderBarHostContext);
      return <div data-testid="pdf-reader" />;
    },
  };
});
vi.mock("~/scient/pdf/usePdfSaveCopy", () => ({ usePdfSaveCopy: () => savePdfCopy }));
vi.mock("../writing/dockChrome", () => ({
  DockMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DockCommandItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  DockCommandRadioItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    disabled: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
// Keep export gates mounted without opening a popup or re-entering the menu's utils cycle.
vi.mock("@base-ui/react/menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@base-ui/react/menu")>();
  return {
    ...actual,
    Menu: {
      ...actual.Menu,
      Portal: (props: React.ComponentProps<typeof actual.Menu.Portal>) => (
        <actual.Menu.Portal {...props} keepMounted />
      ),
    },
  };
});
vi.mock("../documentExport/DocumentExportMenuItems", () => ({
  DocumentExportMenuItems: (props: NonNullable<typeof exportMenu.props>) => {
    exportMenu.props = props;
    return null;
  },
}));
vi.mock("./LatexProjectVisualEditor", async () => {
  const { useContext, useEffect } = await import("react");
  const { ReaderBarHostContext } = await import("../writing/readerBarHost");
  return {
    LatexProjectVisualEditor: (props: NonNullable<typeof visual.props>) => {
      visual.props = props;
      const host = useContext(ReaderBarHostContext);
      visual.host = host;
      const slot = host?.slot ?? null;
      const onHosted = host?.onHosted;
      // The real editor draws its reader controls into the slot and says so.
      useEffect(() => {
        if (!visual.hosts || !onHosted || slot === null) return;
        onHosted(true);
        return () => onHosted(false);
      }, [onHosted, slot]);
      return <div data-testid="visual-editor" />;
    },
  };
});
vi.mock("./useLatexAutoBuild", () => ({ useLatexAutoBuild: () => {} }));
vi.mock("./client", () => ({
  readLatexBuildStatus,
  readLatexToolchain: vi.fn().mockRejectedValue(new Error("Compiler availability not checked")),
  requestLatexForwardSync: sync.forward,
  requestLatexInverseSync: sync.inverse,
  requestLatexPageAnchors: sync.pages,
}));
vi.mock("~/scient/wordExport/WordFileExportDialog", () => ({
  WordFileExportDialog: (props: { savedRevision: () => Promise<string | null> }) => {
    exportDialog.savedRevision = props.savedRevision;
    return <div data-testid="word-export" />;
  },
}));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./useLatexDocumentResolution", () => ({
  useLatexDocumentResolution: () => ({
    pending: false,
    error: null,
    result: { _tag: "resolved", rootRelativePath: "paper.tex" },
  }),
}));
vi.mock("./latexBuildStore", () => ({
  useLatexBuild: () => {
    useSyncExternalStore(
      (listener) => {
        build.listeners.add(listener);
        return () => {
          build.listeners.delete(listener);
        };
      },
      () => build.version,
    );
    return {
      snapshot: build.snapshot,
      toolchain: build.toolchain,
      toolchainReport: build.toolchainReport,
      canInstallManaged: build.canInstallManaged,
      managedInstall: build.managedInstall,
      installRequesting: build.installRequesting,
      error: null,
      requesting: false,
    };
  },
  requestLatexRebuild,
  startWatchingLatexBuild: () => () => {},
  notifyLatexBindingChange,
  cancelLatexBuild: () => {},
  requestManagedLatexInstall,
}));

import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";

import {
  documentReconcileStrategy,
  markdownPersistenceRegistry,
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { createMarkdownPersistenceTransport } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";
import { resolveShortcutCommand } from "~/keybindings";

import { ScientLatexSurface } from "./ScientLatexSurface";
import { flushVisualDraft, readPersistedVisualDraft } from "./visualDrafts";

const environmentId = EnvironmentId.make("synthetic-environment");
const cwd = "/synthetic-workspace";
const relativePath = "paper.tex";
const revisionOf = (source: string) =>
  `sha256:${[...sha256(new TextEncoder().encode(source))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
const BASE = "\\documentclass{article}\n\\begin{document}\nBase.\n\\end{document}\n";

/** This fixture owns one complete native file, not an assembled project. */
function editVisualSource(
  expected: string,
  next: string,
  snapshot = visual.props!.sourceSnapshot,
): boolean {
  const patch = latexOwnedSourcePatch(expected, 0, expected.length, next);
  return visual.props!.onEdit({
    snapshot,
    edit: { source: expected, patches: patch ? [patch] : [] },
  }).accepted;
}

describe("the LaTeX surface on a document session", () => {
  let disk: { source: string; revision: string };
  let lease: MarkdownPersistenceLease;
  const draftKey = `${environmentId}\0${cwd}\0${relativePath}`;

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());

    localStorage.clear();
    notifyLatexBindingChange.mockReset();
    build.snapshot = null;
    build.toolchain = null;
    build.toolchainReport = null;
    build.canInstallManaged = false;
    build.managedInstall = null;
    build.installRequesting = false;
    requestManagedLatexInstall.mockReset();
    requestLatexRebuild.mockReset();
    sourcePane.props = null;
    exportDialog.savedRevision = null;
    exportMenu.props = null;
    visual.props = null;
    visual.host = null;
    visual.hosts = false;
    reader.host = null;
    disk = { source: BASE, revision: revisionOf(BASE) };
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: createTestCheckpointStore(),
      debounceMs: 250,
      reconcile: documentReconcileStrategy,
      createTransport: () => ({
        write: async (intent: MarkdownSaveIntent) => {
          if (intent.expectedRevision !== disk.revision) throw "conflict";
          disk = { source: intent.source, revision: revisionOf(intent.source) };
          return { revision: disk.revision };
        },
        read: async () => disk,
        classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const initial: ProjectReadFileResult = {
      relativePath,
      contents: disk.source,
      revision: disk.revision,
      byteLength: disk.source.length,
      truncated: false,
    };
    lease = registry.acquire({ environmentId, cwd, relativePath }, initial)!;
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    lease.release();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }

  // The panel re-renders the surface with the session's draft, as it does in the app.
  function Host({ mode }: { mode: "source" | "split" | "visual" }) {
    const snapshot = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
    return (
      <ScientLatexSurface
        onDownloadActions={() => {}}
        onRenameContext={() => {}}
        startBar={null}
        templateActions={null}
        environmentId={environmentId}
        cwd={cwd}
        relativePath={relativePath}
        latexRootRelativePath={null}
        composerDraftTarget={"draft" as never}
        contents={snapshot.draftSource}
        revision={snapshot.baselineRevision}
        truncated={false}
        persistence={lease}
        resolvedTheme="light"
        revealLine={null}
        revealRequestId={0}
        latexPresentationRequest={{ mode } as never}
        wordWrap={false}
        onPostRender={() => {}}
        onOpenFileSource={() => {}}
        onLatexPresentationRequestHandled={() => {}}
      />
    );
  }
  async function mount(_fixture: _Fixture, mode: "source" | "split" | "visual" = "split") {
    await act(async () => {
      build.version++;
      for (const listener of build.listeners) listener();
      await _fixture.root0.rerender(<Host mode={mode} />);
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  }
  const typed = (body: string) => BASE.replace("Base.", body);
  const stored = () => {
    flushVisualDraft(draftKey);
    return readPersistedVisualDraft(draftKey);
  };

  it.each(["source", "visual"] as const)(
    "owns Save in %s even when the composer's global listener mounted first",
    async (mode) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const stash = vi.fn();
      const composerShortcut = (event: KeyboardEvent) => {
        const command = resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform: "MacIntel",
          context: { terminalFocus: false, terminalOpen: false, modelPickerOpen: false },
        });
        if (command !== "composer.stash") return;
        event.preventDefault();
        event.stopPropagation();
        stash();
      };
      const composer = document.createElement("textarea");
      document.body.append(composer);
      window.addEventListener("keydown", composerShortcut, true);
      try {
        await mount(_fixture, mode);
        await act(async () => {
          lease.change(typed("Save from the editor."), lease.getSnapshot().editVersion);
        });
        const editor = _fixture.container.querySelector<HTMLElement>(
          `[data-testid="${mode === "source" ? "source-pane" : "visual-editor"}"]`,
        )!;
        editor.tabIndex = 0;
        editor.focus();
        const save = () =>
          new KeyboardEvent("keydown", {
            key: "s",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          });
        await act(async () => {
          editor.dispatchEvent(save());
        });
        expect(stash).not.toHaveBeenCalled();
        expect(disk.source).toBe(typed("Save from the editor."));

        await act(async () => {
          lease.change(typed("Still pending in the editor."), lease.getSnapshot().editVersion);
        });
        composer.focus();
        await act(async () => {
          composer.dispatchEvent(save());
        });
        expect(stash).toHaveBeenCalledOnce();
        expect(disk.source).toBe(typed("Save from the editor."));
      } finally {
        window.removeEventListener("keydown", composerShortcut, true);
        composer.remove();
      }
    },
  );

  describe("the header row", () => {
    const toolbar = (_fixture: _Fixture) =>
      _fixture.container.querySelector<HTMLElement>(".scient-latex-toolbar")!;
    const slot = (_fixture: _Fixture) =>
      _fixture.container.querySelector<HTMLElement>(".scient-latex-reader-slot")!;
    const ownActions = (_fixture: _Fixture) =>
      _fixture.container.querySelector<HTMLElement>(".scient-latex-actions")!;

    it("takes the document's controls into the same row as the view switch", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      visual.hosts = true;
      await mount(_fixture, "visual");
      expect(slot(_fixture).hidden).toBe(false);
      expect(slot(_fixture).parentElement).toBe(toolbar(_fixture));
      expect(visual.host?.slot).toBe(slot(_fixture));
      // The build status leads and the view switch follows the search, inside
      // the hosted controls; the row does not draw them a second time.
      expect(visual.host?.leading).toBeTruthy();
      expect(visual.host?.afterSearch).toBeTruthy();
      expect(toolbar(_fixture).querySelector(":scope > .scient-latex-modes")).toBeNull();
      expect(toolbar(_fixture).querySelector(":scope > .scient-latex-status")).toBeNull();
      // Rebuild and the document's commands travel with the hosted controls,
      // so the row does not draw them a second time.
      expect(toolbar(_fixture).hasAttribute("data-reader-hosted")).toBe(true);
      expect(ownActions(_fixture).childElementCount).toBe(0);
      expect(visual.host?.trailing).toBeTruthy();
      expect(visual.host?.moreActions).toBeTruthy();
      // Only Split has a second switch to offer.
      expect(visual.host?.afterPage).toBeNull();
    });

    it("keeps its own Rebuild until some controls are drawn in the row", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await mount(_fixture, "visual");
      expect(slot(_fixture).hidden).toBe(false);
      expect(toolbar(_fixture).hasAttribute("data-reader-hosted")).toBe(false);
      expect(
        toolbar(_fixture).querySelector(':scope > [aria-label="Document view"]'),
      ).not.toBeNull();
      expect(ownActions(_fixture).querySelector("button")).not.toBeNull();
    });

    it("offers Split's own switch to whichever pane is on the right", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      build.snapshot = {
        logicalDocumentKey: "latex:paper.tex",
        rootRelativePath: "paper.tex",
        state: "succeeded",
        diagnostics: [],
        descriptor: PdfSourceDescriptor.make({
          _tag: "generated-pdf",
          authority: ArtifactAuthority.make("environment-latex"),
          logicalDocumentKey: LogicalDocumentKey.make("latex:paper.tex"),
          artifactId: ArtifactId.make("artifact-1"),
          revisionId: ArtifactRevisionId.make("revision-1"),
          bindingGeneration: BindingGeneration.make(1),
          bindingStatus: "current",
          staleReason: null,
          title: "paper",
          fileName: "paper.pdf",
          capabilities: { canSaveCopy: true, canRevealSource: false },
        }),
        failureSummary: null,
        startedAtEpochMs: null,
        finishedAtEpochMs: null,
        toolchain: null,
        pendingRerun: false,
      };
      await mount(_fixture, "split");
      expect(slot(_fixture).hidden).toBe(false);
      expect(reader.host?.slot).toBe(slot(_fixture));
      expect(reader.host?.afterPage).toBeTruthy();
      expect(reader.host?.trailing).toBeTruthy();
    });

    it("leaves the Source view with the plain row", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      visual.hosts = true;
      await mount(_fixture, "source");
      expect(slot(_fixture).hidden).toBe(true);
      // The search field's room stays, empty, so the view switch does not move.
      const room = toolbar(_fixture).querySelector<HTMLElement>(
        ":scope > .scient-latex-search-room",
      )!;
      expect(room).not.toBeNull();
      expect(room.classList.contains("scient-reader-search")).toBe(true);
      expect(room.nextElementSibling?.getAttribute("aria-label")).toBe("Document view");
      expect(toolbar(_fixture).hasAttribute("data-reader-hosted")).toBe(false);
      expect(ownActions(_fixture).querySelector("button")).not.toBeNull();
    });
  });

  it("keeps the saved source ahead of its PDF stale until a matching build receipt arrives", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const snapshot = {
      logicalDocumentKey: "latex:paper.tex",
      rootRelativePath: "paper.tex",
      state: "succeeded",
      diagnostics: [],
      descriptor: PdfSourceDescriptor.make({
        _tag: "generated-pdf",
        authority: ArtifactAuthority.make("environment-latex"),
        logicalDocumentKey: LogicalDocumentKey.make("latex:paper.tex"),
        artifactId: ArtifactId.make("freshness-artifact"),
        revisionId: ArtifactRevisionId.make("freshness-revision"),
        bindingGeneration: BindingGeneration.make(1),
        bindingStatus: "current",
        staleReason: null,
        title: "paper",
        fileName: "paper.pdf",
        capabilities: { canSaveCopy: true, canRevealSource: false },
      }),
      failureSummary: null,
      startedAtEpochMs: null,
      finishedAtEpochMs: null,
      toolchain: null,
      pendingRerun: false,
      visualSourceRevisions: { "paper.tex": revisionOf(BASE) },
    };
    build.snapshot = snapshot;
    build.toolchain = {
      kind: "tectonic",
      executable: "tectonic",
      version: "test",
      probedAtEpochMs: 1,
    };
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(Uint8Array.from(sha256(new TextEncoder().encode(BASE))).buffer);
    try {
      await mount(_fixture, "source");
      expect(exportMenu.props!.pdfDisabled).toBe(false);
      const status = () => _fixture.container.querySelector(".scient-latex-status")!.textContent;
      expect(status()).not.toContain("Rebuild required");

      const next = typed("A saved paragraph that the old PDF cannot contain.");
      await act(async () => {
        lease.change(next, lease.getSnapshot().editVersion);
      });
      expect(status()).toContain("Rebuild required");
      expect(exportMenu.props!.pdfDisabled).toBe(true);

      digest.mockResolvedValue(Uint8Array.from(sha256(new TextEncoder().encode(next))).buffer);
      await act(async () => {
        expect(await lease.flushNow()).toBe(true);
      });
      expect(lease.getSnapshot().pending).toBe(false);
      expect(disk.source).toBe(next);
      expect(status()).toContain("Rebuild required");
      expect(exportMenu.props!.pdfDisabled).toBe(true);

      const currentSnapshot = {
        ...snapshot,
        visualSourceRevisions: { "paper.tex": revisionOf(next) },
      };
      build.snapshot = currentSnapshot;
      await mount(_fixture, "source");
      expect(status()).not.toContain("Rebuild required");
      expect(exportMenu.props!.pdfDisabled).toBe(false);

      build.snapshot = { ...currentSnapshot, state: "running" };
      await mount(_fixture, "source");
      expect(status()).toContain("Building…");
      expect(status()).toContain("Previous PDF");
      expect(status()).not.toContain("Rebuild required");

      build.snapshot = { ...currentSnapshot, state: "failed", failureSummary: "Compiler failed." };
      await mount(_fixture, "source");
      expect(status()).toContain("Build failed");
      expect(status()).not.toContain("Rebuild required");

      build.snapshot = { ...currentSnapshot, state: "running", descriptor: null };
      await mount(_fixture, "source");
      expect(status()).toContain("Building…");
      expect(status()).not.toContain("Previous PDF");
    } finally {
      digest.mockRestore();
    }
  });

  describe("explicit installation for the document compiler", () => {
    const source = `% !TeX program = lualatex\n${BASE}`;
    const report = (available: boolean): ScientLatexToolchainReport => ({
      kind: available ? "latexmk" : "tectonic",
      executable: available ? "/managed/latexmk" : "/system/tectonic",
      version: "1",
      probedAtEpochMs: available ? 2 : 1,
      canInstallManaged: true,
      downloadBytes: 67_051_368,
      compilers: ["pdflatex", "xelatex", "lualatex"].map((compiler) => ({
        compiler: compiler as "pdflatex" | "xelatex" | "lualatex",
        available,
        executable: available ? `/managed/${compiler}` : null,
        version: available ? "1" : null,
      })),
    });
    const setInstall = (state: ScientLatexManagedInstallState["state"]) => {
      build.managedInstall = {
        state,
        version: "2026.08",
        bytesReceived: null,
        totalBytes: null,
        failureReason: null,
        updatedAtEpochMs: 2,
      };
    };
    const setReport = (available: boolean) => {
      build.toolchainReport = report(available);
      build.toolchain = build.toolchainReport;
    };
    const installButton = (_fixture: _Fixture) =>
      _fixture.container.querySelector<HTMLButtonElement>(".scient-latex-setup-action")!;
    const start = async (_fixture: _Fixture, mode: "source" | "visual" = "source") => {
      setReport(false);
      build.canInstallManaged = true;
      await act(async () => {
        lease.change(source, lease.getSnapshot().editVersion);
        await lease.flushNow();
      });
      await mount(_fixture, mode);
    };
    const requestInstall = async (_fixture: _Fixture) => {
      await act(async () => installButton(_fixture).click());
      setInstall("downloading");
      await mount(_fixture, "source");
    };
    const finishInstall = async (_fixture: _Fixture, available = true) => {
      setReport(available);
      setInstall("ready");
      await mount(_fixture, "source");
    };

    it.each(["source", "visual"] as const)(
      "offers a missing declared engine in %s without downloading on open",
      async (mode) => {
        await using _fixture = _createFixture();
        _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
        await _setupFixture0(_fixture);

        await start(_fixture, mode);
        expect(installButton(_fixture).disabled).toBe(false);
        expect(requestManagedLatexInstall).not.toHaveBeenCalled();
        expect(requestLatexRebuild).not.toHaveBeenCalled();
        await requestInstall(_fixture);
        expect(requestManagedLatexInstall).toHaveBeenCalledExactlyOnceWith({
          environmentId,
          cwd,
          relativePath,
        });
        await finishInstall(_fixture);
        expect(requestLatexRebuild).toHaveBeenCalledExactlyOnceWith(
          { environmentId, cwd, relativePath },
          { reprobeToolchain: false },
        );
        expect(disk.source).toBe(source);
        await mount(_fixture, "source");
        expect(requestLatexRebuild).toHaveBeenCalledTimes(1);
      },
    );

    it("does not build a changed document when installation finishes", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await start(_fixture);
      await requestInstall(_fixture);
      const changed = source.replace("Base.", "New work during installation.");
      await act(async () => lease.change(changed, lease.getSnapshot().editVersion));
      await finishInstall(_fixture);
      expect(requestLatexRebuild).not.toHaveBeenCalled();
      expect(lease.getSnapshot().draftSource).toBe(changed);
    });

    it("does not mistake an installation from Settings for a document build request", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await start(_fixture);
      await finishInstall(_fixture);
      expect(requestLatexRebuild).not.toHaveBeenCalled();
      expect(disk.source).toBe(source);
    });

    it("retains the declared engine when installation cannot provide it", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await start(_fixture);
      await requestInstall(_fixture);
      await finishInstall(_fixture, false);
      expect(requestLatexRebuild).not.toHaveBeenCalled();
      expect(disk.source).toBe(source);
      expect(installButton(_fixture).disabled).toBe(false);
    });
  });

  describe("build messages", () => {
    const card = (_fixture: _Fixture) =>
      _fixture.container.querySelector<HTMLElement>('[aria-label="Build messages"]');
    const chip = (_fixture: _Fixture) =>
      _fixture.container.querySelector<HTMLButtonElement>(".scient-latex-chip-warning")!;
    const press = async (target: Element) =>
      await act(async () => {
        target.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
      });
    async function _setupFixture2(_fixture: _Fixture) {
      build.snapshot = {
        logicalDocumentKey: "latex:paper.tex",
        rootRelativePath: "paper.tex",
        state: "succeeded",
        diagnostics: [
          { severity: "warning", message: "Overfull \\hbox.", file: "paper.tex", line: 4 },
        ],
        descriptor: null,
        failureSummary: null,
        startedAtEpochMs: null,
        finishedAtEpochMs: null,
        toolchain: null,
        pendingRerun: false,
      };
    }

    it("opens over the document from the warnings count, and closes from it again", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      await mount(_fixture, "visual");
      expect(card(_fixture)).toBeNull();
      expect(chip(_fixture).textContent).toBe("1 warning");
      await act(async () => chip(_fixture).click());
      expect(card(_fixture)).not.toBeNull();
      expect(chip(_fixture).getAttribute("aria-expanded")).toBe("true");
      // It floats: the card is not a row between the header and the document.
      expect(card(_fixture)!.parentElement!.className).toBe("scient-latex-diagnostics-anchor");
      expect(card(_fixture)!.textContent).toContain("Overfull");
      // No heading and no chrome of its own: the messages are the whole card.
      expect(card(_fixture)!.querySelector("h1, h2, h3, header")).toBeNull();
      await act(async () => chip(_fixture).click());
      expect(card(_fixture)).toBeNull();
    });

    it("closes on a press anywhere else, and stays open while it is used", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      await mount(_fixture, "visual");
      await act(async () => chip(_fixture).click());
      await press(card(_fixture)!.querySelector(".scient-latex-diagnostic")!);
      expect(card(_fixture)).not.toBeNull();
      // The count toggles the card itself; the outside-press rule must not fight it.
      await press(chip(_fixture));
      expect(card(_fixture)).not.toBeNull();
      await press(_fixture.container.querySelector('[data-testid="visual-editor"]')!);
      expect(card(_fixture)).toBeNull();
    });

    it("closes on Escape from the count that opened it", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      await mount(_fixture, "visual");
      await act(async () => chip(_fixture).click());
      expect(card(_fixture)).not.toBeNull();
      await act(async () => {
        chip(_fixture).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(card(_fixture)).toBeNull();
      // Escape in the document itself belongs to the editor, not to the card.
      await act(async () => chip(_fixture).click());
      await act(async () => {
        _fixture.container
          .querySelector('[data-testid="visual-editor"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
          );
      });
      expect(card(_fixture)).not.toBeNull();
    });

    it("closes on Escape from inside the card", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      await mount(_fixture, "visual");
      await act(async () => chip(_fixture).click());
      await act(async () => {
        card(_fixture)!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(card(_fixture)).toBeNull();
    });
  });

  it("gives the source pane the session, so every keystroke has one owner", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "source");
    expect(_fixture.container.querySelector('[data-testid="source-pane"]')).not.toBeNull();
    expect(sourcePane.props?.persistence).toBe(lease);
    for (const retired of ["contents", "revision", "saveResolution", "onContentsChange"])
      expect(sourcePane.props).not.toHaveProperty(retired);
  });

  it("tells the PDF when a save lands, and only then", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(async () => {
      lease.change(typed("Typed."), lease.getSnapshot().editVersion);
    });
    expect(notifyLatexBindingChange).not.toHaveBeenCalled();
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(notifyLatexBindingChange).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      cwd,
      relativePath: "paper.tex",
    });
    // An outside change that is adopted is not this document's save.
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      expect(await lease.refresh()).toBe(true);
    });
    expect(lease.getSnapshot().draftSource).toBe(typed("Agent."));
    expect(notifyLatexBindingChange).toHaveBeenCalledOnce();
  });

  it("offers Word export only for what is saved", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    expect(exportMenu.props!.wordDisabled).toBe(false);
    await act(async () => {
      lease.change(typed("Typed."), lease.getSnapshot().editVersion);
    });
    expect(exportMenu.props!.wordDisabled).toBe(true);
    await act(async () => {
      await lease.flushNow();
    });
    expect(exportMenu.props!.wordDisabled).toBe(false);
    await act(async () => exportMenu.props!.onWordExport());
    expect(await exportDialog.savedRevision!()).toBe(revisionOf(typed("Typed.")));
  });

  it("refuses to export while an outside change conflicts with unsaved edits", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(async () => exportMenu.props!.onWordExport());
    await act(async () => {
      lease.change(typed("Mine."), lease.getSnapshot().editVersion);
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    let revision: string | null = "unset";
    await act(async () => {
      revision = await exportDialog.savedRevision!();
    });
    expect(revision).toBeNull();
    // Both versions are kept; nothing was merged and nothing was overwritten.
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: typed("Mine."),
      conflict: { externalSource: typed("Agent.") },
    });
    expect(disk.source).toBe(typed("Agent."));
    expect(notifyLatexBindingChange).not.toHaveBeenCalled();
  });

  it("takes a Visual edit only on the working source it was made on", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    expect(visual.props!.source).toBe(BASE);
    // Another view of the file moved the working source first.
    await act(async () => {
      lease.change(typed("Source."), lease.getSnapshot().editVersion);
    });
    let accepted = true;
    await act(async () => {
      accepted = editVisualSource(BASE, typed("Visual."));
    });
    expect(accepted).toBe(false);
    expect(lease.getSnapshot().draftSource).toBe(typed("Source."));
    await act(async () => {
      accepted = editVisualSource(typed("Source."), typed("Visual."));
    });
    expect(accepted).toBe(true);
    expect(lease.getSnapshot()).toMatchObject({ draftSource: typed("Visual."), pending: true });
    expect(visual.props!.selectedPending).toBe(true);
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(disk.source).toBe(typed("Visual."));
    expect(visual.props!.selectedPending).toBe(false);
  });

  it("rejects an earlier Visual snapshot after Source changes away and back to identical bytes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    const stale = visual.props!.sourceSnapshot;
    await act(async () => {
      lease.change(typed("Temporary."), lease.getSnapshot().editVersion);
      lease.change(BASE, lease.getSnapshot().editVersion);
    });
    await act(async () => {
      expect(editVisualSource(BASE, typed("Stale."), stale)).toBe(false);
    });
    expect(lease.getSnapshot().draftSource).toBe(BASE);
    expect(disk.source).toBe(BASE);
    await act(async () => {
      expect(editVisualSource(BASE, typed("Current."))).toBe(true);
      expect(await lease.flushNow()).toBe(true);
    });
    expect(disk.source).toBe(typed("Current."));
  });

  it("keeps a Visual edit's recovery copy until the save lands", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    await act(async () => {
      editVisualSource(BASE, typed("Visual."));
    });
    expect(stored()).toEqual({ source: typed("Visual."), baseRevision: revisionOf(BASE) });
    // Text typed in Source over the unsaved Visual edit belongs to the same copy.
    await act(async () => {
      lease.change(typed("Visual, then Source."), lease.getSnapshot().editVersion);
    });
    expect(stored()).toEqual({
      source: typed("Visual, then Source."),
      baseRevision: revisionOf(BASE),
    });
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(stored()).toBeNull();
  });

  it("pauses Visual edits during a conflict and retains the accepted draft without overwriting the newer file", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    await act(async () => {
      editVisualSource(BASE, typed("Mine."));
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      expect(await lease.flushNow()).toBe(false);
    });
    expect(lease.getSnapshot().conflict).not.toBeNull();
    expect(visual.props!.disabled).toBe(true);
    let accepted = false;
    await act(async () => {
      accepted = editVisualSource(typed("Mine."), typed("Mine again."));
    });
    expect(accepted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: typed("Mine."),
      conflict: { externalSource: typed("Agent.") },
    });
    expect(stored()).toEqual({ source: typed("Mine."), baseRevision: revisionOf(BASE) });
    expect(disk.source).toBe(typed("Agent."));
  });

  it("drops the recovery copy of edits the writer gave up for the version on disk", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    await act(async () => {
      editVisualSource(BASE, typed("Mine."));
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      await lease.flushNow();
    });
    await act(async () => {
      expect(await lease.resolveWithDisk()).toBe(true);
    });
    expect(lease.getSnapshot()).toMatchObject({ draftSource: typed("Agent."), conflict: null });
    expect(stored()).toBeNull();
    // The session still offers them back while the document is open.
    expect(lease.getSnapshot().recoverySource).toBe(typed("Mine."));
    expect(visual.props!.disabled).toBe(false);
  });

  it("drops it too when the file changed again before the writer chose the disk", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    await act(async () => {
      editVisualSource(BASE, typed("Mine."));
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      await lease.flushNow();
    });
    expect(lease.getSnapshot().conflict?.externalSource).toBe(typed("Agent."));
    disk = { source: typed("Agent, again."), revision: revisionOf(typed("Agent, again.")) };
    await act(async () => {
      expect(await lease.resolveWithDisk()).toBe(true);
    });
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: typed("Agent, again."),
      conflict: null,
    });
    expect(stored()).toBeNull();
  });

  it("drops it each time, even when the same text is given up twice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    for (const agent of ["Agent.", "Agent, again."]) {
      const current = lease.getSnapshot().draftSource;
      await act(async () => {
        expect(editVisualSource(current, typed("Mine."))).toBe(true);
      });
      disk = { source: typed(agent), revision: revisionOf(typed(agent)) };
      await act(async () => {
        await lease.flushNow();
      });
      expect(stored()).not.toBeNull();
      await act(async () => {
        expect(await lease.resolveWithDisk()).toBe(true);
      });
      expect(lease.getSnapshot().draftSource).toBe(typed(agent));
      expect(stored()).toBeNull();
    }
  });

  it("keeps a recovery copy again for edits the writer takes back", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    await act(async () => {
      editVisualSource(BASE, typed("Mine."));
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      await lease.flushNow();
    });
    await act(async () => {
      await lease.resolveWithDisk();
    });
    expect(stored()).toBeNull();
    await act(async () => {
      expect(lease.restoreRecovery()).toBe(true);
    });
    expect(lease.getSnapshot()).toMatchObject({ draftSource: typed("Mine."), pending: true });
    expect(stored()).toEqual({
      source: typed("Mine."),
      baseRevision: revisionOf(typed("Agent.")),
    });
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(disk.source).toBe(typed("Mine."));
    expect(stored()).toBeNull();
  });

  it("keeps the recovery copy when the writer keeps their edits, until they are saved", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "visual");
    await act(async () => {
      editVisualSource(BASE, typed("Mine."));
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      await lease.flushNow();
    });
    expect(stored()).not.toBeNull();
    await act(async () => {
      expect(await lease.resolveWithLocal(lease.getSnapshot().conflict!.externalRevision)).toBe(
        true,
      );
    });
    expect(disk.source).toBe(typed("Mine."));
    expect(stored()).toBeNull();
  });
});

describe("navigation between LaTeX source and its PDF", () => {
  // The registry the app uses, so a draft of another open file is visible too.
  const registry = markdownPersistenceRegistry;
  let workspace = 0;
  let cwd = "";

  let lease: MarkdownPersistenceLease;
  let chapter: MarkdownPersistenceLease;
  let opened: Array<[string, number | undefined]>;
  let disk: Map<string, string>;
  function NavigationSurface() {
    const source = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
    return (
      <ScientLatexSurface
        onDownloadActions={() => {}}
        onRenameContext={() => {}}
        startBar={null}
        templateActions={null}
        environmentId={environmentId}
        cwd={cwd}
        relativePath={relativePath}
        latexRootRelativePath={null}
        composerDraftTarget={"draft" as never}
        contents={source.draftSource}
        revision={source.baselineRevision}
        truncated={false}
        persistence={lease}
        resolvedTheme="light"
        revealLine={null}
        revealRequestId={0}
        latexPresentationRequest={{ mode: "split" } as never}
        wordWrap={false}
        onPostRender={() => {}}
        onOpenFileSource={(path, line) => opened.push([path, line])}
        onLatexPresentationRequestHandled={() => {}}
      />
    );
  }

  const acquire = (relativePath: string) =>
    registry.acquire(
      { environmentId, cwd, relativePath },
      {
        relativePath,
        contents: BASE,
        revision: revisionOf(BASE),
        byteLength: BASE.length,
        truncated: false,
      },
    )!;
  const typed = (body: string) => BASE.replace("Base.", body);
  const edit = async (target: MarkdownPersistenceLease, body: string) =>
    await act(async () => {
      target.change(typed(body), target.getSnapshot().editVersion);
    });
  const doubleClickSource = async (_fixture: _Fixture) =>
    await act(async () => {
      _fixture.container2
        .querySelector('[data-testid="source-pane"]')!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true }));
    });

  async function _setupFixture3(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());

    localStorage.clear();
    sync.forward.mockReset();
    sync.inverse.mockReset();
    reader.navigation = null;
    sourcePane.props = null;
    opened = [];
    cwd = `/synthetic-navigation-${(workspace += 1)}`;
    disk = new Map([
      [relativePath, BASE],
      ["chapter.tex", BASE],
    ]);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (_algorithm, bytes) =>
        Uint8Array.from(sha256(new Uint8Array(bytes as ArrayBuffer))).buffer,
    );
    vi.mocked(createMarkdownPersistenceTransport).mockImplementation((target) => ({
      write: async (intent) => {
        disk.set(target.relativePath, intent.source);
        return { revision: revisionOf(intent.source) };
      },
      read: async () => {
        const source = disk.get(target.relativePath) ?? BASE;
        return { source, revision: revisionOf(source) };
      },
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }));
    build.snapshot = {
      logicalDocumentKey: "latex:paper.tex",
      rootRelativePath: "paper.tex",
      state: "succeeded",
      diagnostics: [],
      descriptor: PdfSourceDescriptor.make({
        _tag: "generated-pdf",
        authority: ArtifactAuthority.make("environment-latex"),
        logicalDocumentKey: LogicalDocumentKey.make("latex:paper.tex"),
        artifactId: ArtifactId.make("artifact-1"),
        revisionId: ArtifactRevisionId.make("revision-1"),
        bindingGeneration: BindingGeneration.make(1),
        bindingStatus: "current",
        staleReason: null,
        title: "paper",
        fileName: "paper.pdf",
        capabilities: { canSaveCopy: true, canRevealSource: false },
      }),
      failureSummary: null,
      startedAtEpochMs: null,
      finishedAtEpochMs: null,
      toolchain: null,
      pendingRerun: false,
      visualSourceRevisions: { [relativePath]: revisionOf(BASE), "chapter.tex": revisionOf(BASE) },
    };
    lease = acquire(relativePath);
    chapter = acquire("chapter.tex");
    _fixture.container2 = document.createElement("div");
    document.body.append(_fixture.container2);
    _fixture.root1 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container2, router: false }),
    );
    await act(async () => {
      await _fixture.root1.rerender(<NavigationSurface />);
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(reader.navigation).not.toBeNull();
  }
  async function _cleanupFixture4(_fixture: _Fixture) {
    await act(async () => await _fixture.root1.unmount());
    _fixture.container2.remove();
    lease.release();
    chapter.release();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }

  it("finds a saved line in the PDF", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    sync.forward.mockResolvedValue({ _tag: "found", page: 2, x: 10, y: 20 });
    await doubleClickSource(_fixture);
    expect(sync.forward).toHaveBeenCalledOnce();
    expect(sync.forward.mock.calls[0]![1]).toMatchObject({ line: 3 });
    expect(reader.navigation!.forwardTarget).toMatchObject({ page: 2 });
  });

  it("asks the build that compiled this exact source where its pages begin", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    expect(sync.pages).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({
        workspaceRoot: cwd,
        rootRelativePath: relativePath,
        artifactId: "artifact-1",
        revisionId: "revision-1",
      }),
      expect.any(AbortSignal),
    );
    sync.pages.mockClear();
    await edit(lease, "One.\nTwo.");
    expect(sync.pages).not.toHaveBeenCalled();
  });

  it("does not look up a line of an unsaved draft", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    await edit(lease, "One.\nTwo.");
    await doubleClickSource(_fixture);
    expect(sync.forward).not.toHaveBeenCalled();
    expect(_fixture.container2.textContent).toContain("Unsaved changes");
  });

  it("drops an answer that arrives after the draft has moved on", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    let answer!: (result: unknown) => void;
    sync.forward.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await doubleClickSource(_fixture);
    await edit(lease, "One.\nTwo.");
    await act(async () => answer({ _tag: "found", page: 2, x: 10, y: 20 }));
    expect(reader.navigation!.forwardTarget).toBeNull();
  });

  it("reveals the matching source in Split without opening another file", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    sync.inverse.mockResolvedValue({
      _tag: "found",
      relativePath: "chapter.tex",
      sourceRevision: revisionOf(BASE),
      line: 7,
    });
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    expect(opened).toEqual([]);
    expect(sourcePane.props?.reveal).toMatchObject({
      path: "chapter.tex",
      line: 7,
      sourceRevision: revisionOf(BASE),
    });
  });

  it.each([
    ["this file", () => lease, relativePath],
    ["another file of the document", () => chapter, "chapter.tex"],
  ])("does not open a compiled line in an unsaved draft of %s", async (_name, target, path) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    await edit(target(), "One.\nTwo.");
    sync.inverse.mockResolvedValue({
      _tag: "found",
      relativePath: path,
      sourceRevision: revisionOf(BASE),
      line: 7,
    });
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    expect(opened).toEqual([]);
    expect(sourcePane.props?.reveal).not.toEqual(expect.objectContaining({ line: 7 }));
    expect(_fixture.container2.textContent).toContain("Build required");
  });

  it("refuses saved B coordinates while cached build A is still marked current", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    await edit(lease, "Inserted.\nBase.");
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(lease.getSnapshot().pending).toBe(false);
    await doubleClickSource(_fixture);
    expect(sync.forward).not.toHaveBeenCalled();
    expect(reader.navigation!.forwardTarget).toBeNull();
  });

  it("drops a forward answer after an external source refresh without a local edit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    let answer!: (result: unknown) => void;
    sync.forward.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await doubleClickSource(_fixture);
    disk.set(relativePath, typed("Inserted.\nBase."));
    await act(async () => {
      expect(await lease.refresh()).toBe(true);
    });
    await act(async () => answer({ _tag: "found", page: 2, x: 10, y: 20 }));
    expect(reader.navigation!.forwardTarget).toBeNull();
  });

  it.each(["forward", "inverse"] as const)(
    "drops %s answers when the same PDF becomes stale",
    async (direction) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
      await _setupFixture3(_fixture);

      let answer!: (result: unknown) => void;
      sync[direction].mockReturnValue(new Promise((resolve) => (answer = resolve)));
      if (direction === "forward") await doubleClickSource(_fixture);
      else await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
      await act(async () => {
        const current = build.snapshot as ScientLatexBuildSnapshot;
        build.snapshot = {
          ...current,
          descriptor: {
            ...current.descriptor!,
            bindingStatus: "stale",
            staleReason: "Sources changed",
          },
        };
        build.version += 1;
        for (const listener of build.listeners) listener();
      });
      await act(async () =>
        answer(
          direction === "forward"
            ? { _tag: "found", page: 2, x: 10, y: 20 }
            : {
                _tag: "found",
                relativePath: "chapter.tex",
                sourceRevision: revisionOf(BASE),
                line: 7,
              },
        ),
      );
      expect(reader.navigation!.forwardTarget).toBeNull();
      expect(opened).toEqual([]);
      expect(sourcePane.props?.reveal).not.toEqual(expect.objectContaining({ line: 7 }));
    },
  );

  it("refuses a saved or replaced inverse target after the query was issued", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    let answer!: (result: unknown) => void;
    sync.inverse.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    disk.set("chapter.tex", typed("Inserted.\nBase."));
    await act(async () => {
      expect(await chapter.refresh()).toBe(true);
    });
    expect(chapter.getSnapshot().pending).toBe(false);
    await act(async () =>
      answer({
        _tag: "found",
        relativePath: "chapter.tex",
        sourceRevision: revisionOf(BASE),
        line: 7,
      }),
    );
    expect(opened).toEqual([]);
    expect(sourcePane.props?.reveal).not.toEqual(expect.objectContaining({ line: 7 }));
  });

  it("drops an inverse target ABA even when it is back at compiled A", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    let answer!: (result: unknown) => void;
    sync.inverse.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    disk.set("chapter.tex", typed("B."));
    await act(async () => {
      await chapter.refresh();
    });
    disk.set("chapter.tex", BASE);
    await act(async () => {
      await chapter.refresh();
    });
    await act(async () =>
      answer({
        _tag: "found",
        relativePath: "chapter.tex",
        sourceRevision: revisionOf(BASE),
        line: 7,
      }),
    );
    expect(chapter.getSnapshot().baselineRevision).toBe(revisionOf(BASE));
    expect(opened).toEqual([]);
    expect(sourcePane.props?.reveal).not.toEqual(expect.objectContaining({ line: 7 }));
  });

  it("does not block a current inverse target because another source has a draft", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
    await _setupFixture3(_fixture);

    await edit(chapter, "Unrelated draft.");
    sync.inverse.mockResolvedValue({
      _tag: "found",
      relativePath,
      sourceRevision: revisionOf(BASE),
      line: 7,
    });
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    expect(opened).toEqual([]);
    expect(sourcePane.props?.reveal).toMatchObject({
      path: relativePath,
      line: 7,
      sourceRevision: revisionOf(BASE),
    });
    expect(chapter.getSnapshot().pending).toBe(true);
  });
});

/** Exercise the real surface actions, dependency walker and global session registry. */
describe("document actions before Visual has ever mounted", () => {
  const PAPER = BASE.replace("Base.", "\\input{chapter}\n\\input{data.txt}");
  const registry = markdownPersistenceRegistry;
  let workspace = 0;
  let cwd: string;

  let selected: MarkdownPersistenceLease;
  let chapter: MarkdownPersistenceLease;
  let disk: Map<string, string>;
  let writeGate: Promise<void> | undefined;
  let writeStarted: ReturnType<typeof deferred<void>>;
  let built: ReturnType<typeof deferred<void>>;
  let statusRead: ReturnType<typeof deferred<void>>;
  const writes = vi.fn();
  const freshDescriptor = () =>
    PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make("environment-latex"),
      logicalDocumentKey: LogicalDocumentKey.make("latex:paper.tex"),
      artifactId: ArtifactId.make("document-actions-artifact"),
      revisionId: ArtifactRevisionId.make("document-actions-revision"),
      bindingGeneration: BindingGeneration.make(1),
      bindingStatus: "current",
      staleReason: null,
      title: "paper",
      fileName: "paper.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
    });
  const buildSnapshot = () => ({
    logicalDocumentKey: "latex:paper.tex",
    rootRelativePath: "paper.tex",
    state: "succeeded",
    diagnostics: [],
    descriptor: freshDescriptor(),
    failureSummary: null,
    startedAtEpochMs: null,
    finishedAtEpochMs: null,
    toolchain: null,
    pendingRerun: false,
    // The server's visual receipt covers TeX files only; recorder freshness
    // covers data.txt through the descriptor returned by the fresh status call.
    visualSourceRevisions: {
      "paper.tex": revisionOf(disk.get("paper.tex")!),
      "chapter.tex": revisionOf(disk.get("chapter.tex")!),
    },
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const acquire = (relativePath: string) => {
    const source = disk.get(relativePath)!;
    return registry.acquire(
      { environmentId, cwd, relativePath },
      {
        relativePath,
        contents: source,
        revision: revisionOf(source),
        byteLength: source.length,
        truncated: false,
      },
    )!;
  };
  async function _setupFixture5(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());

    localStorage.clear();
    cwd = `/synthetic-document-actions-${++workspace}`;
    disk = new Map([
      ["paper.tex", PAPER],
      ["chapter.tex", "Original chapter."],
      ["data.txt", "Original data."],
    ]);
    writeGate = undefined;
    writeStarted = deferred<void>();
    built = deferred<void>();
    statusRead = deferred<void>();
    writes.mockReset();
    visual.props = null;
    exportMenu.props = null;
    exportDialog.savedRevision = null;
    requestLatexRebuild.mockReset().mockImplementation(() => built.resolve());
    savePdfCopy.mockReset().mockResolvedValue(undefined);
    readLatexBuildStatus.mockReset().mockImplementation(async () => {
      statusRead.resolve();
      return buildSnapshot();
    });
    vi.mocked(createMarkdownPersistenceTransport).mockImplementation((target) => ({
      read: async () => {
        const source = disk.get(target.relativePath);
        if (source === undefined) throw new Error(`Missing ${target.relativePath}`);
        return { source, revision: revisionOf(source) };
      },
      write: async (intent) => {
        writeStarted.resolve();
        await writeGate;
        if (intent.expectedRevision !== revisionOf(disk.get(target.relativePath)!))
          throw "conflict";
        writes(target.relativePath, intent.source);
        disk.set(target.relativePath, intent.source);
        return { revision: revisionOf(intent.source) };
      },
      classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
      subscribe: () => () => {},
      project: () => {},
    }));
    selected = acquire("paper.tex");
    chapter = acquire("chapter.tex");
    build.snapshot = buildSnapshot();
    build.toolchain = {
      kind: "latexmk",
      executable: "latexmk",
      version: "test",
      probedAtEpochMs: 1,
    };
    // Resolve the actual hash asynchronously but deterministically within act.
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(
      Uint8Array.from(sha256(new TextEncoder().encode(PAPER))).buffer,
    );
    _fixture.container3 = document.createElement("div");
    document.body.append(_fixture.container3);
    _fixture.root2 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container3, router: false }),
    );
    await act(
      async () =>
        await _fixture.root2.rerender(
          <ScientLatexSurface
            onDownloadActions={() => {}}
            onRenameContext={() => {}}
            startBar={null}
            templateActions={null}
            environmentId={environmentId}
            cwd={cwd}
            relativePath="paper.tex"
            latexRootRelativePath={null}
            composerDraftTarget={"draft" as never}
            contents={PAPER}
            revision={revisionOf(PAPER)}
            truncated={false}
            persistence={selected}
            resolvedTheme="light"
            revealLine={null}
            revealRequestId={0}
            latexPresentationRequest={{ mode: "split" } as never}
            wordWrap={false}
            onPostRender={() => {}}
            onOpenFileSource={() => {}}
            onLatexPresentationRequestHandled={() => {}}
          />,
        ),
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(visual.props).toBeNull();
    expect(_fixture.container3.querySelector('[data-testid="visual-editor"]')).toBeNull();
    expect(_fixture.container3.querySelector('[data-testid="source-pane"]')).not.toBeNull();
  }
  async function _cleanupFixture6(_fixture: _Fixture) {
    await act(async () => await _fixture.root2.unmount());
    _fixture.container3.remove();
    selected.release();
    chapter.release();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
  const editChapter = async () =>
    await act(async () => {
      chapter.change("Unsaved chapter.", chapter.getSnapshot().editVersion);
    });
  const triggerBuild = async (_fixture: _Fixture, action: "keyboard" | "button") =>
    await act(async () => {
      const button = _fixture.container3.querySelector<HTMLButtonElement>(
        '[aria-label="Rebuild PDF"]',
      )!;
      if (action === "button") button.click();
      else {
        button.focus();
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
        );
      }
    });
  it.each(["keyboard", "button"] as const)(
    "%s saves the independently edited chapter before requesting a build",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
      await _setupFixture5(_fixture);

      const gate = deferred<void>();
      writeGate = gate.promise;
      await editChapter();
      await triggerBuild(_fixture, action);
      expect(
        await Promise.race([
          writeStarted.promise.then(() => "write"),
          built.promise.then(() => "build"),
        ]),
      ).toBe("write");
      expect(requestLatexRebuild).not.toHaveBeenCalled();
      expect(disk.get("chapter.tex")).toBe("Original chapter.");
      await act(async () => {
        gate.resolve();
        await built.promise;
      });
      expect(writes).toHaveBeenCalledExactlyOnceWith("chapter.tex", "Unsaved chapter.");
      expect(requestLatexRebuild).toHaveBeenCalledExactlyOnceWith(
        { environmentId, cwd, relativePath: "paper.tex" },
        { reprobeToolchain: action === "button" },
      );
      expect(visual.props).toBeNull();
    },
  );
  it("Manual Source-only Cmd+S saves the independent chapter without requesting a PDF build", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
    await _setupFixture5(_fixture);

    localStorage.setItem(LATEX_COMPILATION_STORAGE_KEY, JSON.stringify("manual"));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: LATEX_COMPILATION_STORAGE_KEY }));
    });
    const sourceButton = [
      ..._fixture.container3.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Source")!;
    await act(async () => sourceButton.click());
    const gate = deferred<void>();
    writeGate = gate.promise;
    await editChapter();
    await triggerBuild(_fixture, "keyboard");
    await writeStarted.promise;
    expect(requestLatexRebuild).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
      expect(await chapter.flushNow()).toBe(true);
    });
    expect(disk.get("chapter.tex")).toBe("Unsaved chapter.");
    expect(requestLatexRebuild).not.toHaveBeenCalled();
    expect(visual.props).toBeNull();
    await triggerBuild(_fixture, "button");
    await act(async () => {
      await built.promise;
    });
    expect(requestLatexRebuild).toHaveBeenCalledTimes(1);
  });
  it("On save builds from Source-only after the independent chapter has saved", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
    await _setupFixture5(_fixture);

    const sourceButton = [
      ..._fixture.container3.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Source")!;
    await act(async () => sourceButton.click());
    await editChapter();
    await triggerBuild(_fixture, "keyboard");
    await act(async () => {
      await built.promise;
    });
    expect(disk.get("chapter.tex")).toBe("Unsaved chapter.");
    expect(requestLatexRebuild).toHaveBeenCalledExactlyOnceWith(
      { environmentId, cwd, relativePath: "paper.tex" },
      { reprobeToolchain: false },
    );
  });
  it("Word export waits for the independent chapter save before returning the root revision", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
    await _setupFixture5(_fixture);

    const gate = deferred<void>();
    writeGate = gate.promise;
    await editChapter();
    await act(async () => exportMenu.props!.onWordExport());
    let result!: Promise<string | null>;
    await act(async () => {
      result = exportDialog.savedRevision!();
    });
    expect(
      await Promise.race([writeStarted.promise.then(() => "write"), result.then(() => "export")]),
    ).toBe("write");
    expect(disk.get("chapter.tex")).toBe("Original chapter.");
    let savedRevision: string | null = null;
    await act(async () => {
      gate.resolve();
      savedRevision = await result;
    });
    expect(savedRevision).toBe(revisionOf(PAPER));
    expect(disk.get("chapter.tex")).toBe("Unsaved chapter.");
  });
  it("Word export refuses a conflicting independent chapter and keeps both versions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
    await _setupFixture5(_fixture);

    await editChapter();
    disk.set("chapter.tex", "Outside chapter.");
    await act(async () => exportMenu.props!.onWordExport());
    let result: string | null = "unset";
    await act(async () => {
      result = await exportDialog.savedRevision!();
    });
    expect(result).toBeNull();
    expect(chapter.getSnapshot()).toMatchObject({
      draftSource: "Unsaved chapter.",
      conflict: { externalSource: "Outside chapter." },
    });
    expect(disk.get("chapter.tex")).toBe("Outside chapter.");
    expect(writes).not.toHaveBeenCalled();
  });
  it("PDF export permits a current server receipt with a clean non-TeX include", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
    await _setupFixture5(_fixture);

    expect(exportMenu.props!.pdfDisabled).toBe(false);
    await act(async () => {
      exportMenu.props!.onPdfExport();
      await statusRead.promise;
    });
    expect(readLatexBuildStatus).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: cwd,
      relativePath: "paper.tex",
    });
    expect(savePdfCopy).toHaveBeenCalledExactlyOnceWith(freshDescriptor());
    expect(registry.has({ environmentId, cwd, relativePath: "data.txt" })).toBe(false);
  });
  it.each(["tex", "nontex"] as const)(
    "PDF export refuses refreshed %s evidence that no longer matches the document",
    async (kind) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture6(_fixture));
      await _setupFixture5(_fixture);

      const status = buildSnapshot();
      if (kind === "tex") {
        status.visualSourceRevisions["chapter.tex"] = revisionOf("Older compiled chapter.");
      } else {
        disk.set("data.txt", "New data saved by another editor.");
        const descriptor = freshDescriptor();
        if (descriptor._tag !== "generated-pdf") throw new Error("Expected generated PDF fixture");
        status.descriptor = PdfSourceDescriptor.make({
          ...descriptor,
          bindingStatus: "stale",
          staleReason: "Source changed",
        });
      }
      readLatexBuildStatus.mockImplementation(async () => {
        statusRead.resolve();
        return status;
      });
      // The cached UI still looks current; only the fresh server check can refuse it.
      expect(exportMenu.props!.pdfDisabled).toBe(false);
      await act(async () => {
        exportMenu.props!.onPdfExport();
        await statusRead.promise;
      });
      expect(readLatexBuildStatus).toHaveBeenCalledOnce();
      expect(savePdfCopy).not.toHaveBeenCalled();
      expect(_fixture.container3.textContent).toContain("Rebuild needed");
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    container2: undefined! as HTMLDivElement,
    container3: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    root1: undefined! as Screen,
    root2: undefined! as Screen,
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
