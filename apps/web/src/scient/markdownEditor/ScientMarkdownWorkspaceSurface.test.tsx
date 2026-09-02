// @vitest-environment happy-dom

import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";

import {
  ScientMarkdownWorkspaceSurface as ProductionScientMarkdownWorkspaceSurface,
  type ScientMarkdownWorkspaceSurfaceProps,
} from "./ScientMarkdownWorkspaceSurface";
import { ScientMarkdownEditorView } from "./prosemirror/view";
import { useActivePendingSurfaceDeparture } from "../fileSurfaces/usePendingSurfaceDeparture";

type TestSurfaceProps = Omit<
  ScientMarkdownWorkspaceSurfaceProps,
  "authoritativeSnapshot" | "onDraftSourceChange"
> &
  Partial<
    Pick<ScientMarkdownWorkspaceSurfaceProps, "authoritativeSnapshot" | "onDraftSourceChange">
  >;

const ignoreDraftSourceChange = () => undefined;

function ScientMarkdownWorkspaceSurface({
  authoritativeSnapshot,
  onDraftSourceChange = ignoreDraftSourceChange,
  ...props
}: TestSurfaceProps) {
  return (
    <ProductionScientMarkdownWorkspaceSurface
      {...props}
      authoritativeSnapshot={
        authoritativeSnapshot ?? { source: props.source, revision: props.revision }
      }
      onDraftSourceChange={onDraftSourceChange}
    />
  );
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

  it("uses current host bindings and waits for saving before following a wiki link", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const opened = vi.fn();
    const synchronize = vi.spyOn(MarkdownSaveQueue.prototype, "synchronize");
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
      const queue = synchronize.mock.instances[0] as MarkdownSaveQueue;
      const flushed = queue.flush();
      resolveSave({ revision: "r1" });
      await flushed;
    });
    expect(opened).toHaveBeenCalledExactlyOnceWith("current");
  });

  it("treats an observed in-flight publication as its own save and continues newer typing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const synchronize = vi.spyOn(MarkdownSaveQueue.prototype, "synchronize");
    let resolveFirst!: (value: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const persist = vi.fn(async () => ({ revision: "r2" })).mockImplementationOnce(() => first);
    const props = {
      source: "Original",
      revision: "r0",
      ariaLabel: "Watcher acknowledgement race",
      persist,
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => root.render(<ScientMarkdownWorkspaceSurface {...props} />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (item) => item.view?.dom.isConnected,
    )!;
    await act(() => controller.replaceUserSource("First edit"));
    const queue = synchronize.mock.instances[0] as MarkdownSaveQueue;
    let flushing!: Promise<void>;
    await act(() => {
      flushing = queue.flush();
      controller.replaceUserSource("Latest edit");
    });

    // The watcher observes the first published draft while the command reply
    // is unsettled and a newer keystroke is already queued.
    await act(() =>
      root.render(<ScientMarkdownWorkspaceSurface {...props} source="First edit" revision="r1" />),
    );
    await act(() => flushing);

    expect(props.onExternalConflict).not.toHaveBeenCalled();
    expect(props.onSaveFailure).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({
      source: "Latest edit",
      expectedRevision: "r1",
      editVersion: 2,
    });
    expect(controller.view!.state.doc.textContent).toBe("Latest edit");
    expect(controller.session.session).toMatchObject({
      baselineSource: "Latest edit",
      baselineRevision: "r2",
      draftSource: "Latest edit",
      conflict: null,
    });
    expect(queue.pending).toBe(false);
    expect(queue.failureBlocked).toBe(false);
    expect(props.onPendingChange).toHaveBeenLastCalledWith(false);
    expect(props.onSaveConfirmed.mock.calls).toEqual([
      ["First edit", "r1"],
      ["Latest edit", "r2"],
    ]);

    // The retired command can still settle, but its stale response has no
    // authority to re-confirm or overwrite the newer save.
    resolveFirst({ revision: "late-r1" });
    await first;
    await Promise.resolve();
    expect(props.onSaveConfirmed).toHaveBeenCalledTimes(2);
  });

  it("still pauses for genuinely different disk bytes during an in-flight save", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const synchronize = vi.spyOn(MarkdownSaveQueue.prototype, "synchronize");
    let resolveFirst!: (value: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const persist = vi.fn(() => first);
    const props = {
      source: "Original",
      revision: "r0",
      ariaLabel: "External writer race",
      persist,
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() => root.render(<ScientMarkdownWorkspaceSurface {...props} />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (item) => item.view?.dom.isConnected,
    )!;
    await act(() => controller.replaceUserSource("My draft"));
    const queue = synchronize.mock.instances[0] as MarkdownSaveQueue;
    const flushing = queue.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface {...props} source="External edit" revision="r1" />,
      ),
    );

    expect(props.onExternalConflict).toHaveBeenLastCalledWith({
      source: "External edit",
      revision: "r1",
    });
    expect(controller.session.session.conflict?.externalRevision).toBe("r1");
    expect(queue.failureBlocked).toBe(true);
    expect(queue.pending).toBe(true);

    await act(async () => {
      resolveFirst({ revision: "writer-r2" });
      await flushing;
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(props.onSaveConfirmed).not.toHaveBeenCalled();
    expect(props.onSaveFailure).not.toHaveBeenCalled();

    // Resolve only the synthetic conflict so final cleanup cannot publish the
    // abandoned test draft.
    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...props}
          source="External edit"
          revision="r1"
          saveResolution={{ action: "discard", contents: "External edit", revision: "r1" }}
        />,
      ),
    );
  });

  it("discards a dirty document when a manual reload reads unchanged disk bytes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const persist = vi.fn(async () => ({ revision: "r1" }));
    const pending = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const props = {
      source: "Original",
      revision: "r0",
      ariaLabel: "Discard",
      persist,
      onPendingChange: pending,
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };
    await act(() => root.render(<ScientMarkdownWorkspaceSurface {...props} />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (item) => item.view?.dom.isConnected,
    )!;
    await act(() => controller.replaceUserSource("Original!"));
    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...props}
          saveResolution={{ action: "discard", contents: "Original", revision: "r0" }}
        />,
      ),
    );
    expect(controller.view!.state.doc.textContent).toBe("Original");
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rebases a retry from one complete host snapshot before writing again", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockResolvedValueOnce({ revision: "r2" });
    const onSaveConfirmed = vi.fn();
    const onSaveResolutionApplied = vi.fn();
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const synchronize = vi.spyOn(MarkdownSaveQueue.prototype, "synchronize");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const baseProps = {
      source: "Original",
      revision: "r0",
      authoritativeSnapshot: { source: "Original", revision: "r0" },
      ariaLabel: "Retry snapshot fixture",
      persist,
      onPendingChange: vi.fn(),
      onDraftSourceChange: vi.fn(),
      onSaveConfirmed,
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
      onSaveResolutionApplied,
    } satisfies ScientMarkdownWorkspaceSurfaceProps;

    await act(() => root.render(<ScientMarkdownWorkspaceSurface {...baseProps} />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    )!;
    await act(() => controller.replaceUserSource("My draft"));
    const queue = synchronize.mock.instances[0] as MarkdownSaveQueue;
    await act(() => queue.flush());

    expect(queue.failureBlocked).toBe(true);
    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...baseProps}
          authoritativeSnapshot={null}
          saveResolution={{ action: "retry", contents: "External", revision: "r1" }}
        />,
      ),
    );
    await act(() => queue.flush());

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({
      source: "My draft",
      expectedRevision: "r1",
      editVersion: 1,
    });
    expect(controller.session.session).toMatchObject({
      baselineSource: "My draft",
      baselineRevision: "r2",
      draftSource: "My draft",
      conflict: null,
    });
    expect(onSaveConfirmed).toHaveBeenLastCalledWith("My draft", "r2");
    expect(onSaveResolutionApplied).toHaveBeenCalledOnce();
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
    expect(host.querySelector("[aria-label='Bold (Cmd+B)']")).toBeNull();
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
    expect(host.querySelector("[aria-label='Bold (Cmd+B)']")).toBeNull();

    await act(() => handle!.click());

    expect(host.querySelector("[aria-label='Bold (Cmd+B)']")).not.toBeNull();
    expect(
      host.querySelector("[aria-label='Bold (Cmd+B)']")?.getAttribute("data-preserve-icon-weight"),
    ).toBe("true");
    expect(
      host
        .querySelector("[aria-label='Inline Code (Cmd+E)']")
        ?.getAttribute("data-preserve-icon-weight"),
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
    const primaryBold = host.querySelector<HTMLButtonElement>("[aria-label='Bold (Cmd+B)']");
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
          metaKey: true,
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
        ?.querySelector("[aria-label='Replace current match (Enter)'] svg")
        ?.classList.contains("size-3.5"),
    ).toBe(true);
  });

  it("clears pending when an authoritative refresh observes an unsettled saved draft", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    let resolvePersist: ((value: { readonly revision: string }) => void) | null = null;
    const persisted = new Promise<{ readonly revision: string }>((resolve) => {
      resolvePersist = resolve;
    });
    const persist = vi.fn(() => persisted);
    const onPendingChange = vi.fn();
    const onSaveConfirmed = vi.fn();
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    const render = (source: string, revision: string) =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={source}
          revision={revision}
          ariaLabel="Save acknowledgement fixture"
          persist={persist}
          onPendingChange={onPendingChange}
          onSaveConfirmed={onSaveConfirmed}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      );

    await act(() => render("Before\n", "r0"));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    );
    expect(controller).not.toBeUndefined();

    await act(() => controller!.replaceUserSource("After\n"));
    expect(onPendingChange).toHaveBeenCalledWith(true);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(persist).toHaveBeenCalledOnce();

    await act(() => render("After\n", "r1"));
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(onSaveConfirmed).toHaveBeenCalledExactlyOnceWith("After\n", "r1");

    resolvePersist!({ revision: "late-r1" });
    await act(async () => {
      await persisted;
      await Promise.resolve();
    });
    expect(onSaveConfirmed).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("accepts authoritative disk proof after a write command reports failure", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport interrupted"))
      .mockResolvedValue({ revision: "unexpected-r2" });
    const onPendingChange = vi.fn();
    const onSaveConfirmed = vi.fn();
    const onSaveFailure = vi.fn();
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const synchronize = vi.spyOn(MarkdownSaveQueue.prototype, "synchronize");
    const acknowledgePublished = vi.spyOn(MarkdownSaveQueue.prototype, "acknowledgePublished");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const props = {
      source: "Before\n",
      revision: "r0",
      ariaLabel: "Failed command acknowledgement fixture",
      persist,
      onPendingChange,
      onSaveConfirmed,
      onSaveFailure,
      onExternalConflict: vi.fn(),
    };

    await act(() => root.render(<ScientMarkdownWorkspaceSurface {...props} />));
    const controller = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (candidate) => candidate.view?.dom.isConnected,
    )!;
    await act(() => controller.replaceUserSource("After\n"));
    const queue = synchronize.mock.instances[0] as MarkdownSaveQueue;
    await act(() => queue.flush());
    expect(queue.failureBlocked).toBe(true);
    expect(onSaveFailure).toHaveBeenCalledOnce();
    expect(controller.session.session).toMatchObject({
      baselineSource: "Before\n",
      baselineRevision: "r0",
      draftSource: "After\n",
    });

    await act(() =>
      root.render(<ScientMarkdownWorkspaceSurface {...props} source={"After\n"} revision="r1" />),
    );

    expect(acknowledgePublished).toHaveBeenCalledWith("After\n", "r0");
    expect(queue.failureBlocked).toBe(false);
    expect(queue.pending).toBe(false);
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(onSaveConfirmed).toHaveBeenCalledExactlyOnceWith("After\n", "r1");
  });

  it("disposes the save lane and its externally owned editor on unmount", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownSaveQueue.prototype, "dispose");
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
      expect(dispose).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
    });
    expect(dispose).toHaveBeenCalledWith({ flush: true });
    expect(host.querySelector(".ProseMirror")).toBeNull();
  });

  it("keeps its queue and editor alive through React Strict Mode effect rehearsal", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownSaveQueue.prototype, "dispose");
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
    expect(() => {
      const view = activeController!.view!;
      view.dispatch(view.state.tr.insertText("Edited", 1));
    }).not.toThrow();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    const disposedBeforeFinalUnmount = dispose.mock.calls.length;
    const destroyedBeforeFinalUnmount = destroy.mock.calls.length;

    await act(() => root.unmount());
    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(disposedBeforeFinalUnmount + 1);
      expect(destroy).toHaveBeenCalledTimes(destroyedBeforeFinalUnmount + 1);
    });
  });

  it("leaves one editor and no stale save lane through repeated file switches", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownSaveQueue.prototype, "dispose");
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
      expect(dispose).toHaveBeenCalledTimes(12);
      expect(destroy).toHaveBeenCalledTimes(12);
    });
    expect(host.querySelector(".ProseMirror")).toBeNull();
  });
});
