// @vitest-environment happy-dom
import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { requestLatexRebuild, sourcePane, exportDialog } = vi.hoisted(() => ({
  requestLatexRebuild: vi.fn(),
  sourcePane: { props: null as null | Record<string, unknown> },
  exportDialog: { savedRevision: null as null | (() => Promise<string | null>) },
}));

vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  return { useAtomValue: () => AsyncResult.initial() };
});
vi.mock("~/components/files/FilePreviewPanel", () => ({
  MarkdownSourceSurface: (props: Record<string, unknown>) => {
    sourcePane.props = props;
    return <div data-testid="source-pane" />;
  },
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
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
    snapshot: null,
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
  documentReconcileStrategy,
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

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
