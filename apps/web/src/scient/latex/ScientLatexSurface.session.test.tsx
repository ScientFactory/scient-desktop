// @vitest-environment happy-dom
import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { requestLatexRebuild, sourcePane, exportDialog, build, sync, reader } = vi.hoisted(() => ({
  requestLatexRebuild: vi.fn(),
  sourcePane: { props: null as null | Record<string, unknown> },
  exportDialog: { savedRevision: null as null | (() => Promise<string | null>) },
  build: { snapshot: null as unknown },
  sync: { forward: vi.fn(), inverse: vi.fn() },
  reader: {
    navigation: null as null | {
      readonly forwardTarget: unknown;
      readonly onInverseSearch?: (point: { page: number; x: number; y: number }) => void;
    },
  },
}));

vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  return { useAtomValue: () => AsyncResult.initial() };
});
vi.mock("~/components/files/FilePreviewPanel", () => ({
  MarkdownSourceSurface: (props: Record<string, unknown>) => {
    sourcePane.props = props;
    return <div data-testid="source-pane" data-line="3" />;
  },
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));
vi.mock("~/scient/pdf/ScientPdfReader", () => ({
  ScientPdfReader: (props: { syncNavigation?: typeof reader.navigation }) => {
    reader.navigation = props.syncNavigation ?? null;
    return <div data-testid="pdf-reader" />;
  },
}));
vi.mock("./client", () => ({
  requestLatexForwardSync: sync.forward,
  requestLatexInverseSync: sync.inverse,
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
  useLatexBuild: () => ({
    snapshot: build.snapshot,
    toolchain: null,
    canInstallManaged: false,
    managedInstall: null,
    installRequesting: false,
    error: null,
    requesting: false,
  }),
  requestLatexRebuild,
  startWatchingLatexBuild: () => () => {},
  notifyLatexBindingChange: () => {},
  cancelLatexBuild: () => {},
  requestManagedLatexInstall: () => {},
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

import { ScientLatexSurface } from "./ScientLatexSurface";

const environmentId = EnvironmentId.make("synthetic-environment");
const cwd = "/synthetic-workspace";
const relativePath = "paper.tex";
const revisionOf = (source: string) =>
  `sha256:${[...source]
    .reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 0xffffffff, 7)
    .toString(16)
    .padStart(64, "0")}`;
const BASE = "\\documentclass{article}\n\\begin{document}\nBase.\n\\end{document}\n";

describe("the LaTeX surface on a document session", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let disk: { source: string; revision: string };
  let lease: MarkdownPersistenceLease;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    requestLatexRebuild.mockReset();
    build.snapshot = null;
    sourcePane.props = null;
    exportDialog.savedRevision = null;
    disk = { source: BASE, revision: revisionOf(BASE) };
    const registry = new MarkdownPersistenceRegistry({
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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    lease.release();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root.render(
        <ScientLatexSurface
          environmentId={environmentId}
          cwd={cwd}
          relativePath={relativePath}
          latexRootRelativePath={null}
          composerDraftTarget={"draft" as never}
          contents={lease.getSnapshot().draftSource}
          revision={lease.getSnapshot().baselineRevision}
          persistence={lease}
          resolvedTheme="light"
          revealLine={null}
          revealRequestId={0}
          latexPresentationRequest={null}
          wordWrap={false}
          onPostRender={() => {}}
          onOpenFileSource={() => {}}
          onLatexPresentationRequestHandled={() => {}}
        />,
      );
    });
  }
  const exportButton = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Word"),
    )!;
  const typed = (body: string) => BASE.replace("Base.", body);

  it("gives the source pane the session, so every keystroke has one owner", async () => {
    await mount();
    expect(container.querySelector('[data-testid="source-pane"]')).not.toBeNull();
    expect(sourcePane.props?.persistence).toBe(lease);
    for (const retired of ["contents", "revision", "saveResolution", "onSaveConfirmed"])
      expect(sourcePane.props).not.toHaveProperty(retired);
  });

  it("rebuilds the PDF when a save lands, and only then", async () => {
    await mount();
    await act(async () => {
      lease.change(typed("Typed."), lease.getSnapshot().editVersion);
    });
    expect(requestLatexRebuild).not.toHaveBeenCalled();
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(requestLatexRebuild).toHaveBeenCalledExactlyOnceWith({
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
    expect(requestLatexRebuild).toHaveBeenCalledOnce();
  });

  it("offers Word export only for what is saved", async () => {
    await mount();
    expect(exportButton().disabled).toBe(false);
    await act(async () => {
      lease.change(typed("Typed."), lease.getSnapshot().editVersion);
    });
    expect(exportButton().disabled).toBe(true);
    await act(async () => {
      await lease.flushNow();
    });
    expect(exportButton().disabled).toBe(false);
    await act(async () => exportButton().click());
    expect(await exportDialog.savedRevision!()).toBe(revisionOf(typed("Typed.")));
  });

  it("refuses to export while an outside change conflicts with unsaved edits", async () => {
    await mount();
    await act(async () => exportButton().click());
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
    expect(requestLatexRebuild).not.toHaveBeenCalled();
  });
});

describe("navigation between LaTeX source and its PDF", () => {
  // The registry the app uses, so a draft of another open file is visible too.
  const registry = markdownPersistenceRegistry;
  let workspace = 0;
  let cwd = "";
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let lease: MarkdownPersistenceLease;
  let chapter: MarkdownPersistenceLease;
  let opened: Array<[string, number | undefined]>;

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
  const edit = (target: MarkdownPersistenceLease, body: string) =>
    act(async () => {
      target.change(typed(body), target.getSnapshot().editVersion);
    });
  const doubleClickSource = () =>
    act(async () => {
      container
        .querySelector('[data-testid="source-pane"]')!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true }));
    });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    sync.forward.mockReset();
    sync.inverse.mockReset();
    reader.navigation = null;
    opened = [];
    cwd = `/synthetic-navigation-${(workspace += 1)}`;
    vi.mocked(createMarkdownPersistenceTransport).mockImplementation(() => ({
      // Saving never finishes here: each draft stays ahead of the compiled file.
      write: () => new Promise(() => {}),
      read: async () => ({ source: BASE, revision: revisionOf(BASE) }),
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
    };
    lease = acquire(relativePath);
    chapter = acquire("chapter.tex");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ScientLatexSurface
          environmentId={environmentId}
          cwd={cwd}
          relativePath={relativePath}
          latexRootRelativePath={null}
          composerDraftTarget={"draft" as never}
          contents={BASE}
          revision={revisionOf(BASE)}
          persistence={lease}
          resolvedTheme="light"
          revealLine={null}
          revealRequestId={0}
          latexPresentationRequest={{ mode: "split" } as never}
          wordWrap={false}
          onPostRender={() => {}}
          onOpenFileSource={(path, line) => opened.push([path, line])}
          onLatexPresentationRequestHandled={() => {}}
        />,
      );
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(reader.navigation).not.toBeNull();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    lease.release();
    chapter.release();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("finds a saved line in the PDF", async () => {
    sync.forward.mockResolvedValue({ _tag: "found", page: 2, x: 10, y: 20 });
    await doubleClickSource();
    expect(sync.forward).toHaveBeenCalledOnce();
    expect(sync.forward.mock.calls[0]![1]).toMatchObject({ line: 3 });
    expect(reader.navigation!.forwardTarget).toMatchObject({ page: 2 });
  });

  it("does not look up a line of an unsaved draft", async () => {
    await edit(lease, "One.\nTwo.");
    await doubleClickSource();
    expect(sync.forward).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsaved changes");
  });

  it("drops an answer that arrives after the draft has moved on", async () => {
    let answer!: (result: unknown) => void;
    sync.forward.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await doubleClickSource();
    await edit(lease, "One.\nTwo.");
    await act(async () => answer({ _tag: "found", page: 2, x: 10, y: 20 }));
    expect(reader.navigation!.forwardTarget).toBeNull();
  });

  it("opens the source a place in the PDF came from", async () => {
    sync.inverse.mockResolvedValue({ _tag: "found", relativePath: "chapter.tex", line: 7 });
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    expect(opened).toEqual([["chapter.tex", 7]]);
  });

  it.each([
    ["this file", () => lease, relativePath],
    ["another file of the document", () => chapter, "chapter.tex"],
  ])("does not open a compiled line in an unsaved draft of %s", async (_name, target, path) => {
    await edit(target(), "One.\nTwo.");
    sync.inverse.mockResolvedValue({ _tag: "found", relativePath: path, line: 7 });
    await act(async () => reader.navigation!.onInverseSearch!({ page: 1, x: 1, y: 1 }));
    expect(opened).toEqual([]);
    expect(container.textContent).toContain("Unsaved changes");
  });
});
