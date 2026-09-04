// @vitest-environment happy-dom

import { act, StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MarkdownPersistenceCoordinator,
  type MarkdownSaveIntent,
  type MarkdownPersistenceReadResult,
} from "@scientfactory/scient-markdown";
import { EnvironmentId } from "@t3tools/contracts";
import type { MarkdownPersistenceLease } from "./persistence/markdownPersistenceRegistry";

import {
  ScientMarkdownWorkspaceSurface as ProductionScientMarkdownWorkspaceSurface,
  type ScientMarkdownWorkspaceSurfaceProps,
} from "./ScientMarkdownWorkspaceSurface";
import { ScientMarkdownEditorView } from "./prosemirror/view";
import { scientMarkdownShortcut } from "./shortcuts";
import { useActivePendingSurfaceDeparture } from "../fileSurfaces/usePendingSurfaceDeparture";

type TestSurfaceProps = Omit<ScientMarkdownWorkspaceSurfaceProps, "persistence"> & {
  readonly source: string;
  readonly revision: string;
  readonly coordinator?: MarkdownPersistenceCoordinator;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ revision: string }>;
  readonly read?: () => Promise<MarkdownPersistenceReadResult>;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDraftSourceChange?: (source: string) => void;
  readonly onSaveConfirmed?: (source: string, revision: string) => void;
  readonly onSaveFailure?: (error: unknown) => void;
  readonly onExternalConflict?: (snapshot: { source: string; revision: string }) => void;
};

// Cached render props deliberately do not reinitialize the actual persistence owner.
function ScientMarkdownWorkspaceSurface(props: TestSurfaceProps) {
  const bindings = useRef(props);
  useEffect(() => {
    bindings.current = props;
  }, [props]);
  const [coordinator] = useState(
    () =>
      props.coordinator ??
      new MarkdownPersistenceCoordinator({
        source: props.source,
        revision: props.revision,
        write: props.persist,
        read:
          props.read ?? (() => Promise.resolve({ source: props.source, revision: props.revision })),
        classifyFailure: (error) =>
          error === "conflict" ? "conflict" : error === "transient" ? "transient" : "terminal",
      }),
  );
  const persistence = useMemo<MarkdownPersistenceLease>(
    () => ({
      target: {
        environmentId: EnvironmentId.make("fixture"),
        cwd: "/fixture",
        relativePath: "notes.md",
      },
      getSnapshot: coordinator.getSnapshot,
      subscribe: coordinator.subscribe,
      change: (source, version) => {
        const previous = coordinator.getSnapshot().draftSource;
        const accepted = coordinator.change(source, version);
        if (accepted && previous !== source) bindings.current.onDraftSourceChange?.(source);
        return accepted;
      },
      noteFreshnessHint: (reason) => coordinator.noteFreshnessHint(reason),
      flushNow: () => coordinator.flushNow(),
      retry: () => coordinator.retry(),
      refresh: () => coordinator.refresh(),
      resolveWithLocal: (revision) => coordinator.resolveWithLocal(revision),
      resolveWithDisk: () => coordinator.resolveWithDisk(),
      restoreRecovery: () => coordinator.restoreRecovery(),
      holdForRename: () => coordinator.holdForRename(),
      registerExternalProjection: () => () => {},
      resumeExternalUpdates: () => coordinator.resumeExternalUpdates(),
      release: () => {},
    }),
    [coordinator],
  );
  useEffect(() => {
    let previous = coordinator.getSnapshot();
    bindings.current.onPendingChange?.(previous.pending);
    return coordinator.subscribe(() => {
      const current = coordinator.getSnapshot();
      if (current.pending !== previous.pending) bindings.current.onPendingChange?.(current.pending);
      if (current.baselineRevision !== previous.baselineRevision)
        bindings.current.onSaveConfirmed?.(current.baselineSource, current.baselineRevision);
      if (current.error !== null && current.error !== previous.error)
        bindings.current.onSaveFailure?.(current.error);
      if (current.conflict !== null && current.conflict !== previous.conflict)
        bindings.current.onExternalConflict?.({
          source: current.conflict.externalSource,
          revision: current.conflict.externalRevision,
        });
      previous = current;
    });
  }, [coordinator]);
  return <ProductionScientMarkdownWorkspaceSurface {...props} persistence={persistence} />;
}

describe("ScientMarkdownWorkspaceSurface", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountPersistenceFixture(props: TestSurfaceProps) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const changed = vi.spyOn(MarkdownPersistenceCoordinator.prototype, "change");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => root.render(<ScientMarkdownWorkspaceSurface {...props} />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (item) => item.view?.dom.isConnected,
    )!;
    await act(() => controller.replaceUserSource("My draft"));
    const coordinator = changed.mock.instances[0] as MarkdownPersistenceCoordinator;
    return { root, controller, coordinator };
  }

  it("invalidates only the external presentation domain that changed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const refresh = vi.spyOn(ScientMarkdownEditorView.prototype, "refreshExternalPresentation");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const common = {
      source: "See [[Notes]].\n",
      revision: "r0",
      ariaLabel: "Presentation invalidation",
      persist: vi.fn(async () => ({ revision: "r1" })),
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...common}
          resolvedTheme="light"
          workspaceResourceIndexKey="index-a"
        />,
      ),
    );
    expect(refresh).not.toHaveBeenCalled();

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...common}
          resolvedTheme="dark"
          workspaceResourceIndexKey="index-a"
        />,
      ),
    );
    expect(refresh).toHaveBeenCalledExactlyOnceWith("appearance");

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...common}
          resolvedTheme="dark"
          workspaceResourceIndexKey="index-b"
        />,
      ),
    );
    expect(refresh).toHaveBeenNthCalledWith(2, "workspace");
  });

  it("restores a stale rich projection instead of replacing another view's newer edit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const persist = vi.fn(async () => ({ revision: "r1" }));
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Original",
      revision: "r0",
      write: persist,
      read: async () => ({ source: "Original", revision: "r0" }),
      classifyFailure: () => "terminal",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() =>
      root.render(
        <>
          <ScientMarkdownWorkspaceSurface
            source="Original"
            revision="r0"
            ariaLabel="First view"
            persist={persist}
            coordinator={coordinator}
          />
          <ScientMarkdownWorkspaceSurface
            source="Original"
            revision="r0"
            ariaLabel="Second view"
            persist={persist}
            coordinator={coordinator}
          />
        </>,
      ),
    );
    const controllers = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).filter(
      (item) => item.view?.dom.isConnected,
    );
    expect(controllers).toHaveLength(2);
    await act(() => {
      const first = controllers[0]!.view!;
      const second = controllers[1]!.view!;
      first.dispatch(first.state.tr.insertText("A", 1));
      // The second view has not yet consumed React's projection update.
      second.dispatch(second.state.tr.insertText("B", 1));
    });
    expect(coordinator.getSnapshot().draftSource).toBe("AOriginal");
    expect(controllers.map((controller) => controller.view!.state.doc.textContent)).toEqual([
      "AOriginal",
      "AOriginal",
    ]);
    await act(() => coordinator.flushNow());
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      source: "AOriginal",
      expectedRevision: "r0",
      editVersion: 1,
    });
  });

  it("uses current host bindings and waits for saving before following a wiki link", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const opened = vi.fn();
    const synchronize = vi.spyOn(MarkdownPersistenceCoordinator.prototype, "change");
    let resolveSave!: (value: { revision: string }) => void;
    const saved = new Promise<{ revision: string }>((resolve) => {
      resolveSave = resolve;
    });
    const persist = vi.fn(() => saved);
    function Harness({ target }: { target: string }) {
      const [pending, setPending] = useState(false);
      const depart = useActivePendingSurfaceDeparture({
        activeSurfaceId: "notes",
        pendingSurfaceIds: new Set(pending ? ["notes"] : []),
      });
      return (
        <ScientMarkdownWorkspaceSurface
          source="Hello [[other]]."
          revision="r0"
          ariaLabel="Navigation"
          persist={persist}
          onPendingChange={setPending}
          onSaveConfirmed={() => {}}
          onSaveFailure={() => {}}
          onExternalConflict={() => {}}
          onOpenWikiLink={() => depart("other", () => opened(target))}
        />
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => root.render(<Harness target="old" />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (item) => item.view?.dom.isConnected,
    )!;
    await act(() => {
      controller.view!.dispatch(controller.view!.state.tr.insertText("!", 2));
      root.render(<Harness target="current" />);
    });
    await act(() =>
      host
        .querySelector("[data-scient-markdown-wiki-link]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })),
    );
    expect(opened).not.toHaveBeenCalled();
    expect(controller.view?.dom.isConnected).toBe(true);
    await act(async () => {
      const queue = synchronize.mock.instances[0] as MarkdownPersistenceCoordinator;
      const flushed = queue.flushNow();
      resolveSave({ revision: "r1" });
      await flushed;
    });
    expect(opened).toHaveBeenCalledExactlyOnceWith("current");
  });

  it("ignores cached publication props while an immutable save is in flight", async () => {
    let resolve!: (value: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((complete) => {
      resolve = complete;
    });
    const persist = vi.fn(async () => ({ revision: "r2" })).mockImplementationOnce(() => first);
    const props = { source: "Original", revision: "r0", ariaLabel: "Cache race", persist };
    const { root, controller, coordinator } = await mountPersistenceFixture(props);
    let flushing!: Promise<boolean>;
    await act(() => {
      flushing = coordinator.flushNow();
      controller.replaceUserSource("Latest edit");
    });
    await act(() =>
      root.render(<ScientMarkdownWorkspaceSurface {...props} source="My draft" revision="r1" />),
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({
      baselineRevision: "r0",
      draftSource: "Latest edit",
      inFlight: true,
      conflict: null,
    });
    await act(async () => {
      resolve({ revision: "r1" });
      await flushing;
    });
    expect(persist).toHaveBeenLastCalledWith({
      source: "Latest edit",
      expectedRevision: "r1",
      editVersion: 2,
    });
    expect(controller.view!.state.doc.textContent).toBe("Latest edit");
    expect(coordinator.getSnapshot()).toMatchObject({ pending: false, baselineRevision: "r2" });
  });

  it("serializes rapid real shortcuts without losing CRLF or Unicode content", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const source = "שלום 🌍\r\n";
    let resolveFirst!: (value: { readonly revision: string }) => void;
    const firstPersist = new Promise<{ readonly revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const persist = vi
      .fn()
      .mockImplementationOnce(() => firstPersist)
      .mockResolvedValueOnce({ revision: "r2" });
    const onPendingChange = vi.fn();
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const synchronize = vi.spyOn(MarkdownPersistenceCoordinator.prototype, "change");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    try {
      await act(() =>
        root.render(
          <ScientMarkdownWorkspaceSurface
            source={source}
            revision="r0"
            ariaLabel="Shortcut save stress"
            persist={persist}
            onPendingChange={onPendingChange}
            onSaveConfirmed={vi.fn()}
            onSaveFailure={vi.fn()}
            onExternalConflict={vi.fn()}
          />,
        ),
      );
      const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
        (candidate) => candidate.view?.dom.isConnected,
      )!;
      const view = controller.view!;
      const shortcut = (key: string, code: string, shiftKey = false) => {
        const event = new KeyboardEvent("keydown", {
          key,
          code,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          shiftKey,
        });
        view.dom.dispatchEvent(event);
        expect(event.defaultPrevented, `${code} must be owned by the editor`).toBe(true);
      };
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 8)));

      await act(() => {
        shortcut("b", "KeyB");
        shortcut("i", "KeyI");
        shortcut("z", "KeyZ");
        expect(controller.session.session.draftSource).toBe("**שלום 🌍**\r\n");
        shortcut("z", "KeyZ");
      });
      expect(controller.session.session.draftSource).toBe(source);
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(persist).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith(false);

      await act(() => shortcut("b", "KeyB"));
      const queue = synchronize.mock.instances[0] as MarkdownPersistenceCoordinator;
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(persist).toHaveBeenCalledExactlyOnceWith({
        source: "**שלום 🌍**\r\n",
        expectedRevision: "r0",
        editVersion: 5,
      });

      await act(() => shortcut("i", "KeyI"));
      expect(persist).toHaveBeenCalledTimes(1);
      await act(async () => {
        const flushed = queue.flushNow();
        resolveFirst({ revision: "r1" });
        await flushed;
      });

      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist).toHaveBeenLastCalledWith({
        source: "***שלום 🌍***\r\n",
        expectedRevision: "r1",
        editVersion: 6,
      });
      expect(controller.session.session.draftSource).toBe("***שלום 🌍***\r\n");
      expect(controller.session.session.draftSource).not.toMatch(/(^|[^\r])\n/);
      expect(queue.getSnapshot().pending).toBe(false);
      expect(onPendingChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects a conflict only after an ordered read verifies divergent disk bytes", async () => {
    const persist = vi.fn().mockRejectedValue("conflict");
    const read = vi.fn(async () => ({ source: "External edit", revision: "r1" }));
    const { controller, coordinator } = await mountPersistenceFixture({
      source: "Original",
      revision: "r0",
      ariaLabel: "Conflict",
      persist,
      read,
    });
    await act(() => coordinator.flushNow());
    expect(read).toHaveBeenCalledOnce();
    expect(controller.session.session).toMatchObject({
      draftSource: "My draft",
      conflict: { externalSource: "External edit", externalRevision: "r1" },
    });
    expect(await coordinator.flushNow()).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("retains a discarded local draft when explicitly accepting the disk version", async () => {
    const persist = vi.fn().mockRejectedValue("conflict");
    const read = vi.fn(async () => ({ source: "External", revision: "r1" }));
    const { controller, coordinator } = await mountPersistenceFixture({
      source: "Original",
      revision: "r0",
      ariaLabel: "Discard",
      persist,
      read,
    });
    await act(() => coordinator.flushNow());
    await act(() => coordinator.resolveWithDisk());
    expect(controller.view!.state.doc.textContent).toBe("External");
    expect(coordinator.getSnapshot()).toMatchObject({ recoverySource: "My draft", pending: false });
    await act(() => coordinator.restoreRecovery());
    expect(controller.view!.state.doc.textContent).toBe("My draft");
  });

  it("rebases Keep my edits only after rechecking the presented disk revision", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce("conflict")
      .mockResolvedValueOnce({ revision: "r2" });
    const read = vi.fn(async () => ({ source: "External", revision: "r1" }));
    const { controller, coordinator } = await mountPersistenceFixture({
      source: "Original",
      revision: "r0",
      ariaLabel: "Resolve",
      persist,
      read,
    });
    await act(() => coordinator.flushNow());
    await act(() => coordinator.resolveWithLocal("r1"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({
      source: "My draft",
      expectedRevision: "r1",
      editVersion: 1,
    });
    expect(controller.session.session).toMatchObject({
      baselineSource: "My draft",
      baselineRevision: "r2",
      conflict: null,
    });
  });

  it("mounts one always-editable rich document with no source pane", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const persist = vi.fn(async () => ({ revision: "unexpected" }));
    const callbacks = {
      persist,
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...callbacks}
          source={"# Results\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"}
          revision="r0"
          ariaLabel="Results"
        />,
      ),
    );
    const richDocument = host.querySelector(".ProseMirror");
    expect(richDocument?.querySelector("table")).not.toBeNull();
    expect(richDocument?.getAttribute("contenteditable")).toBe("true");
    expect(host.querySelector(".cm-editor")).toBeNull();
    // The dock is always present but starts collapsed: only the handle shows.
    expect(host.querySelector("[aria-label='Document actions']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Show formatting tools']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Bold']")).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("expands the collapsed editing controls from the handle", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={"# Results\n"}
          revision="r0"
          ariaLabel="Results"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );

    expect(host.querySelector(".ProseMirror")).not.toBeNull();
    const handle = host.querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']");
    expect(handle).not.toBeNull();
    expect(host.querySelector("[aria-label='Bold']")).toBeNull();

    await act(() => handle!.click());

    const bold = host.querySelector<HTMLButtonElement>("[aria-label='Bold']");
    expect(bold).not.toBeNull();
    expect(bold?.getAttribute("aria-keyshortcuts")).toBe(
      scientMarkdownShortcut("bold").ariaKeyShortcuts,
    );
    expect(bold?.textContent).toBe("");
    expect(
      host.querySelector("[aria-label='Bold']")?.getAttribute("data-preserve-icon-weight"),
    ).toBe("true");
    expect(
      host.querySelector("[aria-label='Inline code']")?.getAttribute("data-preserve-icon-weight"),
    ).toBe("true");
    expect(
      host
        .querySelector("[aria-label='Add or edit link']")
        ?.getAttribute("data-preserve-icon-weight"),
    ).toBe("true");
    expect(host.querySelector("[aria-label='Hide formatting tools']")).not.toBeNull();
  });

  it("shows distinct Paragraph and Quote icons in the primary editor controls", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const renderExpandedSurface = async (source: string, ariaLabel: string) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      await act(() =>
        root.render(
          <ScientMarkdownWorkspaceSurface
            source={source}
            revision="r0"
            ariaLabel={ariaLabel}
            persist={vi.fn(async () => ({ revision: "r1" }))}
            onPendingChange={vi.fn()}
            onSaveConfirmed={vi.fn()}
            onSaveFailure={vi.fn()}
            onExternalConflict={vi.fn()}
          />,
        ),
      );
      await act(() =>
        host.querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']")!.click(),
      );
      return host;
    };

    const paragraph = await renderExpandedSurface("Plain text.\n", "Paragraph fixture");
    const paragraphStyle = paragraph.querySelector("[aria-label='Style: Paragraph']");
    expect(paragraphStyle?.querySelector(".lucide-text-initial")).not.toBeNull();

    const quote = await renderExpandedSurface("> Quoted text.\n", "Quote fixture");
    const quoteStyle = quote.querySelector("[aria-label='Style: Quote']");
    expect(quoteStyle?.querySelector(".lucide-text-quote")).not.toBeNull();
  });

  it("uses the shared compact popover treatment for link editing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source="Link target.\n"
          revision="r0"
          ariaLabel="Link fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );
    await act(() =>
      host.querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']")!.click(),
    );
    await act(() =>
      host.querySelector<HTMLButtonElement>("[aria-label='Add or edit link']")!.click(),
    );

    const popup = document.body.querySelector<HTMLElement>("[data-slot='popover-popup']");
    const viewport = popup?.querySelector<HTMLElement>("[data-slot='popover-viewport']");
    const input = popup?.querySelector<HTMLInputElement>("[aria-label='Link destination']");
    const cancel = Array.from(popup?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.textContent === "Cancel",
    );
    const apply = Array.from(popup?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.textContent === "Apply",
    );

    expect(popup?.textContent).toContain("Link");
    expect(popup?.textContent).not.toContain("Insert or Edit Link");
    expect(popup?.className).toContain("w-72");
    expect(viewport?.className).toContain("p-2");
    expect(input?.closest("[data-slot='input-control']")?.getAttribute("data-size")).toBe(
      "compact",
    );
    expect(cancel?.className).toContain("h-7");
    expect(apply?.className).toContain("h-7");
  });

  it("offers a stable selection toolbar with searchable recent wiki targets", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const onWikiLinkSelected = vi.fn();
    const source = "לפני האפשרויות אחרי.\n";
    const selectedText = " האפשרויות ";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={source}
          revision="r0"
          ariaLabel="Wiki link fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
          wikiLinkCandidates={[
            { path: "Methods/Protocol.md", target: "Methods/Protocol" },
            { path: "Notes/Background.md", target: "Notes/Background" },
          ]}
          recentWikiLinkPaths={["Notes/Background.md"]}
          onWikiLinkSelected={onWikiLinkSelected}
        />,
      ),
    );
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    );
    expect(controller).not.toBeUndefined();
    const view = controller!.view!;
    const selectionFrom = 1 + source.indexOf(selectedText);
    await act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, selectionFrom, selectionFrom + selectedText.length),
        ),
      );
    });

    const toolbar = document.body.querySelector<HTMLElement>("[aria-label='Text formatting']");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector("[aria-label='Strikethrough']")).toBeNull();
    const wikiLinkButton = toolbar?.querySelector<HTMLButtonElement>(
      "[aria-label='Link selection to a Markdown file']",
    );
    expect(wikiLinkButton?.disabled).toBe(false);

    await act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1, view.state.doc.content.size),
        ),
      );
    });
    expect(toolbar?.querySelector("[aria-label='Link selection to a Markdown file']")).toBe(
      wikiLinkButton,
    );
    expect(wikiLinkButton?.disabled).toBe(true);

    await act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, selectionFrom, selectionFrom + selectedText.length),
        ),
      );
    });
    expect(wikiLinkButton?.disabled).toBe(false);

    await act(() =>
      controller!.view!.dom.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      ),
    );
    expect(document.body.querySelector("[aria-label='Text formatting']")).toBe(toolbar);
    expect(toolbar?.style.visibility).toBe("hidden");
    await act(() => window.dispatchEvent(new MouseEvent("pointerup", { button: 0 })));
    expect(toolbar?.style.visibility).toBe("visible");

    await act(() =>
      host.querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']")?.click(),
    );
    const primaryBold = host.querySelector<HTMLButtonElement>("[aria-label='Bold']");
    await act(() =>
      primaryBold?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    expect(toolbar?.style.visibility).toBe("visible");
    await act(() => window.dispatchEvent(new MouseEvent("pointerup", { button: 0 })));

    await act(() =>
      toolbar
        ?.querySelector<HTMLButtonElement>("[aria-label='Link selection to a Markdown file']")
        ?.click(),
    );
    const popup = document.body.querySelector<HTMLElement>("[data-slot='popover-popup']");
    expect(popup?.textContent).toContain("Recently linked");
    const options = Array.from(popup?.querySelectorAll<HTMLElement>("[role='option']") ?? []);
    expect(options[0]?.textContent).toContain("Background");
    expect(onWikiLinkSelected).not.toHaveBeenCalled();

    await act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1, view.state.doc.content.size),
        ),
      );
    });
    expect(document.body.querySelector("[aria-label='Search Markdown files']")).toBeNull();
    expect(wikiLinkButton?.disabled).toBe(true);

    await act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, selectionFrom, selectionFrom + selectedText.length),
        ),
      );
    });
    await act(() => wikiLinkButton?.click());
    const search = document.body.querySelector<HTMLInputElement>(
      "[aria-label='Search Markdown files']",
    );
    await act(() =>
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    );
    await act(() =>
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );

    expect(onWikiLinkSelected).toHaveBeenCalledExactlyOnceWith("Methods/Protocol.md");
    expect(controller!.session.session.draftSource).toBe(
      "לפני [[Methods/Protocol|האפשרויות]] אחרי.\n",
    );
    expect(document.body.querySelector("[aria-label='Search Markdown files']")).toBeNull();
  });

  it("edits an existing wiki link through the shared picker and commits only a chosen target", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const onDraftSourceChange = vi.fn();
    const onWikiLinkSelected = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={"See [[Methods/Protocol#setup|protocol]] and text.\n"}
          revision="r0"
          ariaLabel="Existing wiki link fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onDraftSourceChange={onDraftSourceChange}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
          wikiLinkCandidates={[
            { path: "Methods/Protocol.md", target: "Methods/Protocol" },
            { path: "Notes/Background.md", target: "Notes/Background" },
          ]}
          onWikiLinkSelected={onWikiLinkSelected}
        />,
      ),
    );
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    )!;
    const view = controller.view!;
    let wikiPosition = -1;
    let wikiNode = view.state.doc;
    view.state.doc.descendants((node, position) => {
      if (node.type.name !== "wiki_link") return;
      wikiPosition = position;
      wikiNode = node;
    });

    await act(() => {
      expect(
        view.someProp("handleDoubleClickOn", (handler) =>
          handler(
            view,
            wikiPosition,
            wikiNode,
            wikiPosition,
            new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }),
            true,
          ),
        ),
      ).toBe(true);
    });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));

    const popup = document.body.querySelector<HTMLElement>("[data-slot='popover-popup']");
    const search = popup?.querySelector<HTMLInputElement>("[aria-label='Search Markdown files']");
    expect(popup?.textContent).toContain("Edit wiki link");
    expect(search?.value).toBe("Protocol");
    expect(search?.selectionStart).toBe(0);
    expect(search?.selectionEnd).toBe("Protocol".length);
    expect(view.dom.querySelector("input")).toBeNull();
    expect(onDraftSourceChange).not.toHaveBeenCalled();

    const protocol = Array.from(
      popup?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? [],
    ).find((option) => option.textContent?.includes("Methods/Protocol.md"));
    await act(() => protocol?.click());
    expect(controller.session.session.draftSource).toBe(
      "See [[Methods/Protocol#setup|protocol]] and text.\n",
    );
    expect(onDraftSourceChange).not.toHaveBeenCalled();
    expect(onWikiLinkSelected).toHaveBeenCalledExactlyOnceWith("Methods/Protocol.md");

    await act(() => {
      expect(
        view.someProp("handleDoubleClickOn", (handler) =>
          handler(
            view,
            wikiPosition,
            wikiNode,
            wikiPosition,
            new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }),
            true,
          ),
        ),
      ).toBe(true);
    });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    const reopenedPopup = document.body.querySelector<HTMLElement>("[data-slot='popover-popup']");
    const reopenedSearch = reopenedPopup?.querySelector<HTMLInputElement>(
      "[aria-label='Search Markdown files']",
    );

    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        reopenedSearch,
        "Background",
      );
      reopenedSearch?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(reopenedPopup?.textContent).toContain("Notes/Background.md");
    expect(controller.session.session.draftSource).toBe(
      "See [[Methods/Protocol#setup|protocol]] and text.\n",
    );
    expect(onDraftSourceChange).not.toHaveBeenCalled();

    const background = Array.from(
      reopenedPopup?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? [],
    ).find((option) => option.textContent?.includes("Notes/Background.md"));
    await act(() => background?.click());
    expect(controller.session.session.draftSource).toBe(
      "See [[Notes/Background|protocol]] and text.\n",
    );
    expect(onDraftSourceChange).toHaveBeenCalledOnce();
    expect(onWikiLinkSelected).toHaveBeenNthCalledWith(2, "Notes/Background.md");
    expect(document.body.querySelector("[aria-label='Search Markdown files']")).toBeNull();

    wikiPosition = -1;
    view.state.doc.descendants((node, position) => {
      if (node.type.name !== "wiki_link") return;
      wikiPosition = position;
      wikiNode = node;
    });
    await act(() => {
      view.someProp("handleDoubleClickOn", (handler) =>
        handler(
          view,
          wikiPosition,
          wikiNode,
          wikiPosition,
          new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }),
          true,
        ),
      );
    });
    const remove = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Remove link"),
    );
    await act(() => remove?.click());
    expect(controller.session.session.draftSource).toBe("See protocol and text.\n");
    expect(onDraftSourceChange).toHaveBeenCalledTimes(2);
  });

  it("uses compact icon controls for common table actions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={"| A | B |\n| --- | --- |\n| 1 | 2 |\n"}
          revision="r0"
          ariaLabel="Table fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );

    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    );
    expect(controller).not.toBeUndefined();
    let cellTextPosition: number | null = null;
    controller!.view!.state.doc.descendants((node, position) => {
      if (
        cellTextPosition === null &&
        (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell")
      ) {
        cellTextPosition = position + 1;
      }
    });
    expect(cellTextPosition).not.toBeNull();

    await act(() => {
      const view = controller!.view!;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, cellTextPosition!)),
      );
    });

    const toolbar = host.querySelector("[aria-label='Table actions']");
    expect(toolbar?.closest("[aria-label='Document actions']")).not.toBeNull();
    expect(host.querySelector(".scient-markdown-table-toolbar")).toBeNull();
    const addRow = toolbar?.querySelector("[aria-label='Add row below']");
    const addColumn = toolbar?.querySelector("[aria-label='Add column after']");
    expect(addRow?.querySelector(".lucide-between-horizontal-end")).not.toBeNull();
    expect(addColumn?.querySelector(".lucide-between-vertical-end")).not.toBeNull();
    expect(toolbar?.textContent).not.toContain("Table:");
    expect(toolbar?.querySelector("[aria-label='Delete row']")).toBeNull();
    expect(toolbar?.querySelector("[aria-label='Delete column']")).toBeNull();
    expect(toolbar?.querySelector("[aria-label='More table actions']")).toBeNull();
    expect(host.querySelectorAll("[aria-label='More actions']")).toHaveLength(1);
    const moreActions = host.querySelector<HTMLButtonElement>("[aria-label='More actions']");
    expect(moreActions).not.toBeNull();
    await act(() => moreActions!.click());
    const menuItems = Array.from(
      document.body.querySelectorAll<HTMLElement>("[data-slot='menu-item']"),
      (item) => item.textContent?.trim(),
    );
    expect(menuItems).toEqual(
      expect.arrayContaining([
        "Add row above",
        "Add row below",
        "Add column before",
        "Add column after",
        "Align column left",
        "Align column center",
        "Align column right",
      ]),
    );
  });

  it("keeps one dock and one document while the cursor moves into and out of a table", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const persist = vi.fn(async () => ({ revision: "r1" }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={"Before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n"}
          revision="r0"
          ariaLabel="Table navigation fixture"
          persist={persist}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    )!;
    const view = controller.view!;
    const dock = host.querySelector(".scient-markdown-editor-dock");
    const documentShell = host.querySelector(".scient-markdown-document-shell");
    const table = view.dom.querySelector("table");
    const cellPositions: number[] = [];
    view.state.doc.descendants((node, position) => {
      if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
        cellPositions.push(position + 2);
      }
    });
    const move = (position: number) =>
      act(() =>
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position))),
      );

    await move(cellPositions[0]!);
    expect(
      host.querySelector("[aria-label='Table actions']")?.closest(".scient-markdown-editor-dock"),
    ).toBe(dock);
    await act(() =>
      host.querySelector<HTMLButtonElement>("[aria-label='Hide formatting tools']")!.click(),
    );
    await move(cellPositions[1]!);
    expect(host.querySelector("[aria-label='Show formatting tools']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Table actions']")).toBeNull();

    await move(1);
    await move(cellPositions[2]!);
    expect(host.querySelector("[aria-label='Table actions']")).not.toBeNull();
    await move(1);
    expect(host.querySelector("[aria-label='Table actions']")).toBeNull();
    expect(host.querySelectorAll(".scient-markdown-editor-dock")).toHaveLength(1);
    expect(host.querySelector(".scient-markdown-editor-dock")).toBe(dock);
    expect(host.querySelector(".scient-markdown-document-shell")).toBe(documentShell);
    expect(view.dom.querySelector("table")).toBe(table);
    expect(persist).not.toHaveBeenCalled();
  });

  it("opens find as a bounded row in document flow instead of a clipped popover", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source="Find this text.\n"
          revision="r0"
          ariaLabel="Find fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );

    const editor = host.querySelector(".ProseMirror");
    expect(editor).not.toBeNull();
    await act(() =>
      editor!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    const richPane = host.querySelector(".scient-markdown-rich-pane");
    const findBar = host.querySelector(".scient-markdown-find-bar");
    expect(findBar).not.toBeNull();
    expect(findBar?.parentElement).toBe(richPane);
    expect(host.querySelector(".scient-markdown-find-popover")).toBeNull();
    const findInput = findBar?.querySelector<HTMLInputElement>("[aria-label='Find text']");
    const findInputGroup = findInput?.closest<HTMLElement>("[data-slot='input-group']");
    expect(findInputGroup).not.toBeNull();
    expect(findInputGroup?.className).toContain("ring-0");
    expect(
      findBar?.querySelector("[aria-label='Match case'] svg")?.classList.contains("size-3.5"),
    ).toBe(true);

    await act(() =>
      findBar?.querySelector<HTMLButtonElement>("[aria-label='Show replace']")?.click(),
    );
    const replacementInput = findBar?.querySelector<HTMLInputElement>(
      "[aria-label='Replacement text']",
    );
    const replacementInputGroup = replacementInput?.closest<HTMLElement>(
      "[data-slot='input-group']",
    );
    expect(replacementInputGroup).not.toBeNull();
    expect(replacementInputGroup?.className).toContain("ring-0");
    expect(
      findBar
        ?.querySelector("[aria-label='Replace current match'] svg")
        ?.classList.contains("size-3.5"),
    ).toBe(true);

    const matchCase = findBar?.querySelector<HTMLButtonElement>("[aria-label='Match case']");
    if (!matchCase) throw new Error("Expected the Match case control to be mounted.");
    await act(() => {
      matchCase.focus();
      matchCase.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector(".scient-markdown-find-bar")).toBeNull();
    expect(document.activeElement).toBe(editor);
  });

  it("keeps pending until the receipt even when query props match the draft", async () => {
    let resolve!: (value: { revision: string }) => void;
    const persisted = new Promise<{ revision: string }>((complete) => {
      resolve = complete;
    });
    const persist = vi.fn(() => persisted);
    const props = {
      source: "Original",
      revision: "r0",
      ariaLabel: "No speculative acknowledgement",
      persist,
    };
    const { root, coordinator } = await mountPersistenceFixture(props);
    let flushed!: Promise<boolean>;
    await act(() => {
      flushed = coordinator.flushNow();
    });
    await act(() =>
      root.render(<ScientMarkdownWorkspaceSurface {...props} source="My draft" revision="r1" />),
    );
    expect(coordinator.getSnapshot()).toMatchObject({ pending: true, baselineRevision: "r0" });
    await act(async () => {
      resolve({ revision: "r1" });
      await flushed;
    });
    expect(coordinator.getSnapshot().pending).toBe(false);
  });

  it("recovers a lost response through an identical retry and ordered verification", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockRejectedValueOnce("transient").mockRejectedValueOnce("conflict");
    const read = vi.fn(async () => ({ source: "My draft", revision: "r1" }));
    const { controller, coordinator } = await mountPersistenceFixture({
      source: "Original",
      revision: "r0",
      ariaLabel: "Lost receipt",
      persist,
      read,
    });
    let flushed!: Promise<boolean>;
    await act(() => {
      flushed = coordinator.flushNow();
    });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(await flushed).toBe(true);
    expect(persist.mock.calls[0]?.[0]).toBe(persist.mock.calls[1]?.[0]);
    expect(read).toHaveBeenCalledOnce();
    expect(controller.session.session).toMatchObject({
      baselineSource: "My draft",
      baselineRevision: "r1",
      conflict: null,
    });
    vi.useRealTimers();
  });

  it("destroys its editor without disposing the shared persistence owner on unmount", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownPersistenceCoordinator.prototype, "dispose");
    const destroy = vi.spyOn(ScientMarkdownEditorView.prototype, "destroy");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source="# Results\n"
          revision="r0"
          ariaLabel="Results"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector(".ProseMirror")).not.toBeNull();

    await act(() => root.unmount());

    await vi.waitFor(() => {
      expect(dispose).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    });
    expect(host.querySelector(".ProseMirror")).toBeNull();
  });

  it("keeps its persistence owner and editor alive through React Strict Mode effect rehearsal", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownPersistenceCoordinator.prototype, "dispose");
    const destroy = vi.spyOn(ScientMarkdownEditorView.prototype, "destroy");
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const onPendingChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(() =>
      root.render(
        <StrictMode>
          <ScientMarkdownWorkspaceSurface
            source="# Results\n"
            revision="r0"
            ariaLabel="Results"
            persist={vi.fn(async () => ({ revision: "r1" }))}
            onPendingChange={onPendingChange}
            onSaveConfirmed={vi.fn()}
            onSaveFailure={vi.fn()}
            onExternalConflict={vi.fn()}
          />
        </StrictMode>,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector(".ProseMirror")).not.toBeNull();
    const mountedControllers = mount.mock.instances as unknown as ScientMarkdownEditorView[];
    const activeController = mountedControllers.find(
      (controller) => controller.view?.dom.isConnected,
    );
    expect(activeController).not.toBeUndefined();
    await act(() => {
      const view = activeController!.view!;
      view.dispatch(view.state.tr.insertText("Edited", 1));
    });
    expect(onPendingChange).toHaveBeenCalledWith(true);
    const disposedBeforeFinalUnmount = dispose.mock.calls.length;
    const destroyedBeforeFinalUnmount = destroy.mock.calls.length;

    await act(() => root.unmount());
    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(disposedBeforeFinalUnmount);
      expect(destroy).toHaveBeenCalledTimes(destroyedBeforeFinalUnmount + 1);
    });
  });

  it("leaves one editor without disposing file persistence through repeated switches", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownPersistenceCoordinator.prototype, "dispose");
    const destroy = vi.spyOn(ScientMarkdownEditorView.prototype, "destroy");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    for (let index = 0; index < 12; index += 1) {
      await act(() =>
        root.render(
          <ScientMarkdownWorkspaceSurface
            key={`document-${index}`}
            source={`# Document ${index}\n`}
            revision={`r${index}`}
            ariaLabel={`Document ${index}`}
            persist={vi.fn(async () => ({ revision: `saved-${index}` }))}
            onPendingChange={vi.fn()}
            onSaveConfirmed={vi.fn()}
            onSaveFailure={vi.fn()}
            onExternalConflict={vi.fn()}
          />,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(host.querySelectorAll(".ProseMirror")).toHaveLength(1);
      expect(host.querySelector("h1")?.textContent).toContain(`Document ${index}`);
    }

    await act(() => root.unmount());
    await vi.waitFor(() => {
      expect(dispose).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(12);
    });
    expect(host.querySelector(".ProseMirror")).toBeNull();
  });

  it("owns editor shortcuts without leaking them to app shortcuts or nested source fields", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(host, outside);
    const root = createRoot(host);
    roots.push(root);
    const sidebarToggle = vi.fn();
    const commandPaletteToggle = vi.fn();
    const onSidebarShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key.toLocaleLowerCase() !== "b") return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      sidebarToggle();
    };
    const onPaletteShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey && event.key.toLocaleLowerCase() === "k") commandPaletteToggle();
    };
    window.addEventListener("keydown", onSidebarShortcut, true);
    window.addEventListener("keydown", onPaletteShortcut);

    try {
      await act(() =>
        root.render(
          <ScientMarkdownWorkspaceSurface
            source={"Text\n\n$$\nx + y\n$$\n\n```ts\nconst value = 1;\n```\n"}
            revision="r0"
            ariaLabel="Shortcut scope"
            persist={vi.fn(async () => ({ revision: "r1" }))}
            onPendingChange={vi.fn()}
            onSaveConfirmed={vi.fn()}
            onSaveFailure={vi.fn()}
            onExternalConflict={vi.fn()}
          />,
        ),
      );
      const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
        (candidate) => candidate.view?.dom.isConnected,
      )!;
      const view = controller.view!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));

      const chrome = host.querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']")!;
      chrome.focus();
      const chromeShortcut = (key: string, code: string) => {
        const event = new KeyboardEvent("keydown", {
          key,
          code,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        });
        chrome.dispatchEvent(event);
        expect(event.defaultPrevented, `${code} must be delegated from editor chrome`).toBe(true);
      };
      await act(() => chromeShortcut("a", "KeyA"));
      expect(view.state.selection).toBeInstanceOf(AllSelection);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
      await act(() => chromeShortcut("b", "KeyB"));
      expect(controller.session.session.draftSource).toContain("**Text**");
      await act(() => chromeShortcut("z", "KeyZ"));
      expect(controller.session.session.draftSource).not.toContain("**Text**");
      await act(() => chromeShortcut("y", "KeyY"));
      expect(controller.session.session.draftSource).toContain("**Text**");
      await act(() => chromeShortcut("z", "KeyZ"));
      expect(controller.session.session.draftSource).not.toContain("**Text**");
      expect(sidebarToggle).not.toHaveBeenCalled();

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
      chrome.focus();
      await act(() => chromeShortcut("k", "KeyK"));
      const chromeLinkInput = await vi.waitFor(() => {
        const inputs = document.body.querySelectorAll<HTMLInputElement>(
          'input[aria-label="Link destination"]',
        );
        expect(inputs).toHaveLength(1);
        return inputs[0]!;
      });
      expect(document.activeElement).toBe(chromeLinkInput);
      expect(commandPaletteToggle).not.toHaveBeenCalled();
      const chromeLinkCancel = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("[data-slot='popover-popup'] button"),
      ).find((button) => button.textContent === "Cancel")!;
      await act(() => chromeLinkCancel.click());
      await vi.waitFor(() => expect(document.activeElement).toBe(view.dom));

      await act(() => {
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "b",
            code: "KeyB",
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        );
      });
      expect(sidebarToggle).not.toHaveBeenCalled();
      expect(controller.session.session.draftSource).toContain("**Text**");

      await act(() => {
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            code: "KeyK",
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        );
      });
      const linkInput = await vi.waitFor(() => {
        const inputs = document.body.querySelectorAll<HTMLInputElement>(
          'input[aria-label="Link destination"]',
        );
        expect(inputs).toHaveLength(1);
        return inputs[0]!;
      });
      expect(document.activeElement).toBe(linkInput);
      expect(commandPaletteToggle).not.toHaveBeenCalled();

      const nestedLinkShortcut = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      await act(() => linkInput.dispatchEvent(nestedLinkShortcut));
      expect(nestedLinkShortcut.defaultPrevented).toBe(true);
      expect(commandPaletteToggle).not.toHaveBeenCalled();
      expect(document.body.querySelectorAll('input[aria-label="Link destination"]')).toHaveLength(
        1,
      );

      const cancel = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("[data-slot='popover-popup'] button"),
      ).find((button) => button.textContent === "Cancel")!;
      await act(() => cancel.click());
      await vi.waitFor(() => expect(document.activeElement).toBe(view.dom));

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      await act(() => {
        view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            code: "KeyK",
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        );
      });
      const caretLinkInput = await vi.waitFor(() => {
        expect(host.querySelector("[aria-label='Hide formatting tools']")).not.toBeNull();
        const inputs = document.body.querySelectorAll<HTMLInputElement>(
          'input[aria-label="Link destination"]',
        );
        expect(inputs).toHaveLength(1);
        return inputs[0]!;
      });
      expect(document.activeElement).toBe(caretLinkInput);
      const caretCancel = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("[data-slot='popover-popup'] button"),
      ).find((button) => button.textContent === "Cancel")!;
      await act(() => caretCancel.click());
      await vi.waitFor(() => expect(document.activeElement).toBe(view.dom));
      expect(commandPaletteToggle).not.toHaveBeenCalled();

      let mathPosition = -1;
      view.state.doc.descendants((node, position) => {
        if (node.type.name === "display_math") mathPosition = position;
      });
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, mathPosition)));
      const mathInput = view.dom.querySelector<HTMLTextAreaElement>(
        ".scient-markdown-math-source",
      )!;
      mathInput.focus();
      const sourceBeforeNestedKeys = controller.session.session.draftSource;
      for (const key of ["a", "z", "c", "x", "v", "b"] as const) {
        const event = new KeyboardEvent("keydown", {
          key,
          code: `Key${key.toUpperCase()}`,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        });
        await act(() => mathInput.dispatchEvent(event));
        expect(event.defaultPrevented, `${key} must remain native to the math input`).toBe(false);
      }
      expect(sidebarToggle).not.toHaveBeenCalled();
      expect(controller.session.session.draftSource).toBe(sourceBeforeNestedKeys);

      const nestedMathLink = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      await act(() => mathInput.dispatchEvent(nestedMathLink));
      expect(nestedMathLink.defaultPrevented).toBe(true);
      expect(commandPaletteToggle).not.toHaveBeenCalled();
      expect(controller.getSnapshot().linkEditRequest).toBe(0);

      const nestedMathFind = new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      await act(() => mathInput.dispatchEvent(nestedMathFind));
      expect(nestedMathFind.defaultPrevented).toBe(true);
      const nestedMathFindInput = await vi.waitFor(() => {
        const input = host.querySelector<HTMLInputElement>("[aria-label='Find text']");
        expect(document.activeElement).toBe(input);
        return input!;
      });
      await act(() =>
        nestedMathFindInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(mathInput));

      let codePosition = -1;
      view.state.doc.descendants((node, position) => {
        if (node.type.name === "code_block") codePosition = position;
      });
      await act(() => {
        view.dispatch(
          view.state.tr.setSelection(NodeSelection.create(view.state.doc, codePosition)),
        );
      });
      const codeEditor = await vi.waitFor(() => {
        const editor = view.dom.querySelector<HTMLElement>(
          ".scient-markdown-code-editor .cm-content",
        );
        expect(editor).not.toBeNull();
        return editor!;
      });
      codeEditor.focus();
      const sourceBeforeCodeKeys = controller.session.session.draftSource;
      for (const key of ["a", "z", "c", "x", "v", "b"] as const) {
        await act(() =>
          codeEditor.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              code: `Key${key.toUpperCase()}`,
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
            }),
          ),
        );
      }
      expect(sidebarToggle).not.toHaveBeenCalled();
      expect(controller.session.session.draftSource).toBe(sourceBeforeCodeKeys);
      const nestedCodeLink = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      await act(() => codeEditor.dispatchEvent(nestedCodeLink));
      expect(nestedCodeLink.defaultPrevented).toBe(true);
      expect(commandPaletteToggle).not.toHaveBeenCalled();
      expect(controller.getSnapshot().linkEditRequest).toBe(0);

      const nestedCodeFind = new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      await act(() => codeEditor.dispatchEvent(nestedCodeFind));
      expect(nestedCodeFind.defaultPrevented).toBe(true);
      const nestedCodeFindInput = await vi.waitFor(() => {
        const input = host.querySelector<HTMLInputElement>("[aria-label='Find text']");
        expect(document.activeElement).toBe(input);
        return input!;
      });
      await act(() =>
        nestedCodeFindInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(codeEditor));

      outside.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", bubbles: true, ctrlKey: true }),
      );
      outside.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", bubbles: true, ctrlKey: true }),
      );
      expect(sidebarToggle).toHaveBeenCalledOnce();
      expect(commandPaletteToggle).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", onSidebarShortcut, true);
      window.removeEventListener("keydown", onPaletteShortcut);
    }
  });
});
