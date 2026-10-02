// @vitest-environment happy-dom
import { sha256 } from "@noble/hashes/sha2";
import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  notifyLatexBindingChange,
  requestLatexRebuild,
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
      onEdit: (expected: string, next: string) => boolean;
      selectedPending: boolean;
      disabled: boolean;
      source: string;
    },
    // The header row's offer to host the editor's controls, and whether to take it.
    host: null as null | import("../writing/readerBarHost").ReaderBarHost,
    hosts: false,
  },
  build: { snapshot: null as unknown, toolchain: null as unknown },
  sync: { forward: vi.fn(), inverse: vi.fn() },
  reader: {
    navigation: null as null | {
      readonly forwardTarget: unknown;
      readonly onInverseSearch?: (point: { page: number; x: number; y: number }) => void;
    },
    host: null as null | import("../writing/readerBarHost").ReaderBarHost,
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
}));
// The header's own More menu is drawn eagerly so its items can be inspected.
vi.mock("~/components/ui/menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/ui/menu")>()),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
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
    toolchain: build.toolchain,
    canInstallManaged: false,
    managedInstall: null,
    installRequesting: false,
    error: null,
    requesting: false,
  }),
  requestLatexRebuild,
  startWatchingLatexBuild: () => () => {},
  notifyLatexBindingChange,
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

describe("the LaTeX surface on a document session", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let disk: { source: string; revision: string };
  let lease: MarkdownPersistenceLease;
  const draftKey = `${environmentId}\0${cwd}\0${relativePath}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    notifyLatexBindingChange.mockReset();
    build.snapshot = null;
    build.toolchain = null;
    sourcePane.props = null;
    exportDialog.savedRevision = null;
    exportMenu.props = null;
    visual.props = null;
    visual.host = null;
    visual.hosts = false;
    reader.host = null;
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

  // The panel re-renders the surface with the session's draft, as it does in the app.
  function Host({ mode }: { mode: "source" | "split" | "visual" }) {
    const snapshot = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
    return (
      <ScientLatexSurface
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
  async function mount(mode: "source" | "split" | "visual" = "split") {
    await act(async () => root.render(<Host mode={mode} />));
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
        await mount(mode);
        await act(async () => {
          lease.change(typed("Save from the editor."), lease.getSnapshot().editVersion);
        });
        const editor = container.querySelector<HTMLElement>(
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
    const toolbar = () => container.querySelector<HTMLElement>(".scient-latex-toolbar")!;
    const slot = () => container.querySelector<HTMLElement>(".scient-latex-reader-slot")!;
    const ownActions = () => container.querySelector<HTMLElement>(".scient-latex-actions")!;

    it("takes the document's controls into the same row as the view switch", async () => {
      visual.hosts = true;
      await mount("visual");
      expect(slot().hidden).toBe(false);
      expect(slot().parentElement).toBe(toolbar());
      expect(toolbar().querySelector('[aria-label="Document view"]')).not.toBeNull();
      expect(visual.host?.slot).toBe(slot());
      // Rebuild and the document's commands travel with the hosted controls,
      // so the row does not draw them a second time.
      expect(toolbar().hasAttribute("data-reader-hosted")).toBe(true);
      expect(ownActions().childElementCount).toBe(0);
      expect(visual.host?.trailing).toBeTruthy();
      expect(visual.host?.moreActions).toBeTruthy();
      // Only Split has a second switch to offer.
      expect(visual.host?.beforeSearch).toBeNull();
    });

    it("keeps its own Rebuild until some controls are drawn in the row", async () => {
      await mount("visual");
      expect(slot().hidden).toBe(false);
      expect(toolbar().hasAttribute("data-reader-hosted")).toBe(false);
      expect(ownActions().querySelector("button")).not.toBeNull();
    });

    it("offers Split's own switch to whichever pane is on the right", async () => {
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
      await mount("split");
      expect(slot().hidden).toBe(false);
      expect(reader.host?.slot).toBe(slot());
      expect(reader.host?.beforeSearch).toBeTruthy();
      expect(reader.host?.trailing).toBeTruthy();
    });

    it("leaves the Source view with the plain row", async () => {
      visual.hosts = true;
      await mount("source");
      expect(slot().hidden).toBe(true);
      expect(toolbar().hasAttribute("data-reader-hosted")).toBe(false);
      expect(ownActions().querySelector("button")).not.toBeNull();
    });
  });

  describe("build messages", () => {
    const card = () => container.querySelector<HTMLElement>('[aria-label="Build messages"]');
    const chip = () => container.querySelector<HTMLButtonElement>(".scient-latex-chip-warning")!;
    const press = (target: Element) =>
      act(async () => {
        target.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
      });
    beforeEach(() => {
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
    });

    it("opens over the document from the warnings count, and closes from it again", async () => {
      await mount("visual");
      expect(card()).toBeNull();
      expect(chip().textContent).toBe("1 warning");
      await act(async () => chip().click());
      expect(card()).not.toBeNull();
      expect(chip().getAttribute("aria-expanded")).toBe("true");
      // It floats: the card is not a row between the header and the document.
      expect(card()!.parentElement!.className).toBe("scient-latex-diagnostics-anchor");
      expect(card()!.textContent).toContain("Overfull");
      // No heading and no chrome of its own: the messages are the whole card.
      expect(card()!.querySelector("h1, h2, h3, header")).toBeNull();
      await act(async () => chip().click());
      expect(card()).toBeNull();
    });

    it("closes on a press anywhere else, and stays open while it is used", async () => {
      await mount("visual");
      await act(async () => chip().click());
      await press(card()!.querySelector(".scient-latex-diagnostic")!);
      expect(card()).not.toBeNull();
      // The count toggles the card itself; the outside-press rule must not fight it.
      await press(chip());
      expect(card()).not.toBeNull();
      await press(container.querySelector('[data-testid="visual-editor"]')!);
      expect(card()).toBeNull();
    });

    it("closes on Escape from the count that opened it", async () => {
      await mount("visual");
      await act(async () => chip().click());
      expect(card()).not.toBeNull();
      await act(async () => {
        chip().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(card()).toBeNull();
      // Escape in the document itself belongs to the editor, not to the card.
      await act(async () => chip().click());
      await act(async () => {
        container
          .querySelector('[data-testid="visual-editor"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
          );
      });
      expect(card()).not.toBeNull();
    });

    it("closes on Escape from inside the card", async () => {
      await mount("visual");
      await act(async () => chip().click());
      await act(async () => {
        card()!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(card()).toBeNull();
    });
  });

  it("gives the source pane the session, so every keystroke has one owner", async () => {
    await mount();
    expect(container.querySelector('[data-testid="source-pane"]')).not.toBeNull();
    expect(sourcePane.props?.persistence).toBe(lease);
    for (const retired of ["contents", "revision", "saveResolution", "onContentsChange"])
      expect(sourcePane.props).not.toHaveProperty(retired);
  });

  it("tells the PDF when a save lands, and only then", async () => {
    await mount();
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
    await mount();
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
    await mount();
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
    await mount("visual");
    expect(visual.props!.source).toBe(BASE);
    // Another view of the file moved the working source first.
    await act(async () => {
      lease.change(typed("Source."), lease.getSnapshot().editVersion);
    });
    let accepted = true;
    await act(async () => {
      accepted = visual.props!.onEdit(BASE, typed("Visual."));
    });
    expect(accepted).toBe(false);
    expect(lease.getSnapshot().draftSource).toBe(typed("Source."));
    await act(async () => {
      accepted = visual.props!.onEdit(typed("Source."), typed("Visual."));
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

  it("keeps a Visual edit's recovery copy until the save lands", async () => {
    await mount("visual");
    await act(async () => {
      visual.props!.onEdit(BASE, typed("Visual."));
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

  it("keeps taking Visual edits while a conflict waits, and never overwrites the newer file", async () => {
    await mount("visual");
    await act(async () => {
      visual.props!.onEdit(BASE, typed("Mine."));
    });
    disk = { source: typed("Agent."), revision: revisionOf(typed("Agent.")) };
    await act(async () => {
      expect(await lease.flushNow()).toBe(false);
    });
    expect(lease.getSnapshot().conflict).not.toBeNull();
    expect(visual.props!.disabled).toBe(false);
    let accepted = false;
    await act(async () => {
      accepted = visual.props!.onEdit(typed("Mine."), typed("Mine again."));
    });
    expect(accepted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: typed("Mine again."),
      conflict: { externalSource: typed("Agent.") },
    });
    expect(stored()).toEqual({ source: typed("Mine again."), baseRevision: revisionOf(BASE) });
    expect(disk.source).toBe(typed("Agent."));
  });

  it("drops the recovery copy of edits the writer gave up for the version on disk", async () => {
    await mount("visual");
    await act(async () => {
      visual.props!.onEdit(BASE, typed("Mine."));
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
    await mount("visual");
    await act(async () => {
      visual.props!.onEdit(BASE, typed("Mine."));
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
    await mount("visual");
    for (const agent of ["Agent.", "Agent, again."]) {
      const current = lease.getSnapshot().draftSource;
      await act(async () => {
        expect(visual.props!.onEdit(current, typed("Mine."))).toBe(true);
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
    await mount("visual");
    await act(async () => {
      visual.props!.onEdit(BASE, typed("Mine."));
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
    await mount("visual");
    await act(async () => {
      visual.props!.onEdit(BASE, typed("Mine."));
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
    localStorage.clear();
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

/** Exercise the real surface actions, dependency walker and global session registry. */
describe("document actions before Visual has ever mounted", () => {
  const PAPER = BASE.replace("Base.", "\\input{chapter}\n\\input{data.txt}");
  const registry = markdownPersistenceRegistry;
  let workspace = 0;
  let cwd: string;
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
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
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ScientLatexSurface
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
    expect(container.querySelector('[data-testid="visual-editor"]')).toBeNull();
    expect(container.querySelector('[data-testid="source-pane"]')).not.toBeNull();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    selected.release();
    chapter.release();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const editChapter = () =>
    act(async () => {
      chapter.change("Unsaved chapter.", chapter.getSnapshot().editVersion);
    });
  const triggerBuild = (action: "keyboard" | "button") =>
    act(async () => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Rebuild PDF"]')!;
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
      const gate = deferred<void>();
      writeGate = gate.promise;
      await editChapter();
      await triggerBuild(action);
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
  it("Source-only Cmd+S saves the independent chapter without requesting a PDF build", async () => {
    const sourceButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Source",
    )!;
    await act(async () => sourceButton.click());
    const gate = deferred<void>();
    writeGate = gate.promise;
    await editChapter();
    await triggerBuild("keyboard");
    await writeStarted.promise;
    expect(requestLatexRebuild).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
      expect(await chapter.flushNow()).toBe(true);
    });
    expect(disk.get("chapter.tex")).toBe("Unsaved chapter.");
    expect(requestLatexRebuild).not.toHaveBeenCalled();
    expect(visual.props).toBeNull();
  });
  it("Word export waits for the independent chapter save before returning the root revision", async () => {
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
      expect(container.textContent).toContain("Rebuild needed");
    },
  );
});
