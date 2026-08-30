// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";

import { ScientMarkdownWorkspaceSurface } from "./ScientMarkdownWorkspaceSurface";
import { ScientMarkdownEditorView } from "./prosemirror/view";

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
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={"Selected words.\n"}
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
    await act(() => {
      const view = controller!.view!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9)));
    });

    const toolbar = document.body.querySelector<HTMLElement>("[aria-label='Text formatting']");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector("[aria-label='Strikethrough']")).toBeNull();
    expect(
      toolbar?.querySelector("[aria-label='Link selection to a Markdown file']"),
    ).not.toBeNull();

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

    const search = popup?.querySelector<HTMLInputElement>("[aria-label='Search Markdown files']");
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
    expect(controller!.session.session.draftSource).toBe("[[Methods/Protocol|Selected]] words.\n");
    expect(document.body.querySelector("[aria-label='Search Markdown files']")).toBeNull();
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
    const addRow = toolbar?.querySelector("[aria-label='Add row below']");
    const addColumn = toolbar?.querySelector("[aria-label='Add column after']");
    expect(addRow?.querySelector(".lucide-between-horizontal-end")).not.toBeNull();
    expect(addColumn?.querySelector(".lucide-between-vertical-end")).not.toBeNull();
    expect(toolbar?.textContent).not.toContain("Table:");
    expect(toolbar?.querySelector("[aria-label='Delete row']")).toBeNull();
    expect(toolbar?.querySelector("[aria-label='Delete column']")).toBeNull();
    const moreActions = toolbar?.querySelector<HTMLButtonElement>(
      "[aria-label='More table actions']",
    );
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
      ]),
    );
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
