// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state";
import { DOMParser } from "prosemirror-model";
import { scientMarkdownSchema } from "./schema";

import { ScientMarkdownEditorView } from "./view";

describe("ScientMarkdownEditorView", () => {
  it.each(["ltr", "rtl"])("preserves explicit %s direction through DOM parsing", (dir) => {
    const host = document.createElement("div");
    host.innerHTML = `<p dir="${dir}">שלום world</p><h2 dir="${dir}">English עברית</h2><p dir="auto">Auto</p>`;
    const doc = DOMParser.fromSchema(scientMarkdownSchema).parse(host);
    expect(doc.child(0).attrs.dir).toBe(dir);
    expect(doc.child(1).attrs.dir).toBe(dir);
    expect(doc.child(2).attrs.dir).toBeNull();
  });
  const mounted: ScientMarkdownEditorView[] = [];

  afterEach(() => {
    mounted.splice(0).forEach((controller) => controller.destroy());
    document.body.replaceChildren();
    document.documentElement.classList.remove("dark");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mountEditor() {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Heading\n\n- one\n  - nested\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    return { controller, host, onUserSourceChange, view: controller.mount(host) };
  }

  it("edits front matter through one persistent source surface without changing adjacent Markdown", () => {
    const controller = new ScientMarkdownEditorView({
      source: "---\ntitle: Before\n---\n\nBody\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Front matter",
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));

    const editor = view.dom.querySelector<HTMLTextAreaElement>(
      ".scient-markdown-source-island-editor",
    )!;
    expect(view.dom.querySelector(".scient-markdown-source-island-preview")).toBeNull();
    expect(editor.hidden).toBe(false);
    expect(editor.readOnly).toBe(false);

    editor.value = "---\ntitle: After\n---";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(controller.session.session.draftSource).toBe("---\ntitle: After\n---\n\nBody\n");
    expect(editor.value).toBe("---\ntitle: After\n---");

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(view.dom.querySelector(".scient-markdown-source-island-editor")).toBe(editor);
    expect(editor.hidden).toBe(false);

    controller.setMode("read");
    expect(editor.readOnly).toBe(true);
    controller.setMode("write");
    expect(editor.readOnly).toBe(false);
  });

  it.each(["caret", "selection"])("updates and removes an existing link with a %s", (kind) => {
    const controller = new ScientMarkdownEditorView({
      source: "[Example](https://old.example)\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Link",
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, kind === "caret" ? 3 : 1, kind === "caret" ? 3 : 8),
      ),
    );
    expect(controller.currentLink()?.href).toBe("https://old.example");
    expect(controller.setLink("https://new.example")).toBe(true);
    expect(controller.session.session.draftSource).toBe("[Example](https://new.example)\n");
    expect(controller.removeLink()).toBe(true);
    expect(controller.session.session.draftSource).toBe("Example\n");
  });

  it("right-clicks an ordinary link into its existing editor and unlink command", async () => {
    let action: "open" | "copy-link" | "copy-full-path" | "edit" | "remove" = "open";
    const showLinkContextMenu = vi.fn(async () => action);
    const onCopyLink = vi.fn();
    const onOpenLink = vi.fn();
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "[one **two** three](old.md) beside\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Link context menu",
      onOpenLink,
      onCopyLink,
      resolveLinkFullPath: (_kind, target) => `/workspace/${target}`,
      onUserSourceChange,
      showLinkContextMenu,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const link = host.querySelector<HTMLAnchorElement>("a[href]")!;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 27,
    });

    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("old.md", link));
    expect(onUserSourceChange).not.toHaveBeenCalled();

    action = "copy-link";
    link.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 18, clientY: 27 }),
    );
    await vi.waitFor(() =>
      expect(onCopyLink).toHaveBeenCalledExactlyOnceWith({ format: "link", value: "old.md" }, link),
    );

    action = "edit";
    link.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 18, clientY: 27 }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().linkEditRequest).toBe(1));
    expect(showLinkContextMenu).toHaveBeenLastCalledWith({
      canCopy: true,
      canOpen: true,
      editable: true,
      fullPath: "/workspace/old.md",
      kind: "link",
      position: { x: 18, y: 27 },
      target: "old.md",
    });
    expect(controller.currentLink()).toMatchObject({ href: "old.md", from: 1, to: 14 });
    expect(view.state.selection).toMatchObject({ from: 1, to: 14 });
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.acknowledgeLinkEditRequest(1);
    action = "remove";
    link.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    );
    await vi.waitFor(() => {
      expect(controller.session.session.draftSource).toBe("one **two** three beside\n");
    });
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("right-clicks a wiki link into its searchable editor and preserves its label on removal", async () => {
    let action: "open" | "copy-link" | "copy-full-path" | "edit" | "remove" = "open";
    const showLinkContextMenu = vi.fn(async () => action);
    const onCopyLink = vi.fn();
    const onOpenWikiLink = vi.fn();
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Notes/Methods|protocol]] here.\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Wiki context menu",
      onOpenWikiLink,
      onCopyLink,
      resolveLinkFullPath: () => "/workspace/Notes/Methods.md",
      onUserSourceChange,
      showLinkContextMenu,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const link = host.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]")!;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 32,
      clientY: 41,
    });

    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(onOpenWikiLink).toHaveBeenCalledExactlyOnceWith("Notes/Methods", link),
    );
    expect(onUserSourceChange).not.toHaveBeenCalled();

    action = "copy-full-path";
    link.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 32, clientY: 41 }),
    );
    await vi.waitFor(() =>
      expect(onCopyLink).toHaveBeenCalledExactlyOnceWith(
        {
          format: "full-path",
          value: "/workspace/Notes/Methods.md",
        },
        link,
      ),
    );

    action = "edit";
    link.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 32, clientY: 41 }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().wikiLinkEditRequest).toBe(1));
    expect(showLinkContextMenu).toHaveBeenCalledWith({
      canCopy: true,
      canOpen: true,
      editable: true,
      fullPath: "/workspace/Notes/Methods.md",
      kind: "wiki-link",
      position: { x: 32, y: 41 },
      target: "Notes/Methods",
    });
    expect(controller.getSnapshot().selectedWikiLinkTarget).toBe("Notes/Methods");
    expect(view.state.selection).toMatchObject({ from: 5, to: 6 });
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.acknowledgeWikiLinkEditRequest(1);
    action = "remove";
    link.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 35, clientY: 44 }),
    );
    await vi.waitFor(() => {
      expect(controller.session.session.draftSource).toBe("See protocol here.\n");
    });
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("creates a link to a filename with spaces that remains a link on reopen", () => {
    const { controller, view } = mountEditor();
    controller.setMode("write");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 8)));
    expect(controller.setLink("Other notes.md")).toBe(true);
    const reopened = new ScientMarkdownEditorView({
      source: controller.session.session.draftSource,
      revision: "r1",
      ariaLabel: "Reopened",
    });
    mounted.push(reopened);
    expect(reopened.session.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe(
      "Other%20notes.md",
    );
  });

  it("updates a whole caret link across inline formatting without changing adjacent links", () => {
    const controller = new ScientMarkdownEditorView({
      source: "[one **two** three](old.md) [next](next.md)\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Links",
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    expect(controller.setLink("new.md")).toBe(true);
    expect(controller.session.session.draftSource).toBe(
      "[one **two** three](new.md) [next](next.md)\n",
    );
    const before = controller.session.session.draftSource;
    expect(controller.setLink("javascript:alert(1)")).toBe(false);
    expect(controller.session.session.draftSource).toBe(before);
  });

  it("updates only the selected portion of a link or mixed link/plain text", () => {
    const controller = new ScientMarkdownEditorView({
      source: "[Example](old.md) plain\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Links",
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 6)));
    controller.setLink("partial.md");
    expect(controller.session.session.draftSource).toBe(
      "[Ex](old.md)[amp](partial.md)[le](old.md) plain\n",
    );
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 14)));
    controller.setLink("mixed.md");
    expect(controller.session.session.draftSource).toBe(
      "[Ex](old.md)[amp](partial.md)[le plain](mixed.md)\n",
    );
  });

  it("keeps a single text row visible when its direction changes", () => {
    const controller = new ScientMarkdownEditorView({
      source: "Only row.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(controller.execute("direction-ltr")).toBe(true);
    expect(view.dom.querySelector("p[dir='ltr']")?.textContent).toBe("Only row.");

    expect(controller.execute("direction-rtl")).toBe(true);
    expect(view.dom.querySelector("p[dir='rtl']")?.textContent).toBe("Only row.");
    expect(view.state.doc.textContent).toBe("Only row.");
  });

  it("anchors the selection toolbar only to inline text selections", () => {
    const { controller, view } = mountEditor();
    expect(controller.selectionToolbarAnchor()).toBeNull();

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 5)));
    expect(controller.selectionToolbarAnchor()).not.toBeNull();

    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 2, view.state.doc.content.size),
      ),
    );
    expect(controller.selectionToolbarAnchor()).not.toBeNull();
    expect(controller.getSnapshot().canSetWikiLink).toBe(false);

    const codeController = new ScientMarkdownEditorView({
      source: "```\ncode\n```\n",
      revision: "sha256:b",
      ariaLabel: "Code document",
      onUserSourceChange: () => undefined,
    });
    const codeHost = document.createElement("div");
    document.body.append(codeHost);
    mounted.push(codeController);
    const codeView = codeController.mount(codeHost);
    codeView.dispatch(codeView.state.tr.setSelection(NodeSelection.create(codeView.state.doc, 0)));
    expect(codeController.selectionToolbarAnchor()).toBeNull();
  });

  it("turns an inline text selection into a labeled wiki link", () => {
    const controller = new ScientMarkdownEditorView({
      source: "Selected words.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9)));

    expect(controller.setWikiLink(" Methods/Protocol ")).toBe(true);
    expect(controller.session.session.draftSource).toBe("[[Methods/Protocol|Selected]] words.\n");
    expect(view.dom.querySelector("[data-scient-markdown-wiki-link]")?.textContent).toContain(
      "Selected",
    );
  });

  it("links a trimmed Hebrew pointer selection without consuming its surrounding spaces", () => {
    const source = "לפני האפשרויות אחרי.\n";
    const selectedText = " האפשרויות ";
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Hebrew document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const from = 1 + source.indexOf(selectedText);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, from, from + selectedText.length),
      ),
    );

    expect(controller.getSnapshot().canSetWikiLink).toBe(true);
    expect(controller.setWikiLink("Notes/Options")).toBe(true);
    expect(controller.session.session.draftSource).toBe("לפני [[Notes/Options|האפשרויות]] אחרי.\n");
  });

  it("retargets a deliberately selected wiki-link label", () => {
    const controller = new ScientMarkdownEditorView({
      source: "See [[Methods|the method]] next.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    let wikiPosition: number | null = null;
    let wikiSize = 0;
    view.state.doc.descendants((node, position) => {
      if (node.type.name !== "wiki_link") return;
      wikiPosition = position;
      wikiSize = node.nodeSize;
    });

    expect(wikiPosition).not.toBeNull();
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, wikiPosition!, wikiPosition! + wikiSize),
      ),
    );
    expect(controller.getSnapshot().canSetWikiLink).toBe(true);
    expect(controller.setWikiLink("Results")).toBe(true);
    expect(controller.session.session.draftSource).toBe("See [[Results|the method]] next.\n");
  });

  it("removes a deliberately selected wiki link without losing its visible label", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Methods|the method]] and [[Results]].\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const positions: Array<{ readonly position: number; readonly size: number }> = [];
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "wiki_link") positions.push({ position, size: node.nodeSize });
    });

    const aliased = positions[0]!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, aliased.position, aliased.position + aliased.size),
      ),
    );
    expect(controller.removeWikiLink()).toBe(true);
    expect(controller.session.session.draftSource).toBe("See the method and [[Results]].\n");
    expect(view.state.selection).toMatchObject({
      from: aliased.position,
      to: aliased.position + "the method".length,
    });
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("keeps one mounted view and document through 100 read/write cycles", () => {
    const { controller, host, onUserSourceChange, view } = mountEditor();
    const documentNode = view.state.doc;
    const renderedHeading = view.dom.querySelector("h1");
    const sourceBefore = controller.session.session.draftSource;
    const revisionBefore = controller.session.session.baselineRevision;
    const geometryBefore = view.dom.getBoundingClientRect().toJSON();
    host.scrollTop = 147;
    const transactionSpy = vi.spyOn(controller.session, "applyTransaction");

    for (let index = 0; index < 100; index += 1) {
      controller.setMode("write");
      expect(view.editable).toBe(true);
      controller.setMode("read");
      expect(view.editable).toBe(false);
    }

    expect(controller.view).toBe(view);
    expect(view.state.doc).toBe(documentNode);
    expect(view.dom.querySelector("h1")).toBe(renderedHeading);
    expect(view.dom.getBoundingClientRect().toJSON()).toEqual(geometryBefore);
    expect(host.scrollTop).toBe(147);
    expect(controller.session.session.draftSource).toBe(sourceBefore);
    expect(controller.session.session.baselineRevision).toBe(revisionBefore);
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(view.dom.getAttribute("role")).toBe("document");
    expect(view.dom.hasAttribute("aria-readonly")).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("activates the existing rendered document and emits only a real user edit", () => {
    const { controller, onUserSourceChange, view } = mountEditor();
    const renderedHeading = view.dom.querySelector("h1");
    expect(renderedHeading?.textContent).toBe("Heading");

    controller.setMode("write");
    expect(view.dom.querySelector("h1")).toBe(renderedHeading);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    view.dispatch(view.state.tr.insertText("Updated ", 1, 1));
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(onUserSourceChange.mock.calls[0]?.[0]).toContain("# Updated Heading");
  });

  it("opens an empty file with a focused caret and accepts the first text", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "",
      revision: "sha256:empty",
      mode: "write",
      ariaLabel: "Empty Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(view.dom.getAttribute("contenteditable")).toBe("true");
    expect(view.dom.getAttribute("aria-placeholder")).toBe("Start writing");
    expect(view.dom.classList.contains("is-empty")).toBe(true);
    expect(document.activeElement).toBe(view.dom);

    view.dispatch(view.state.tr.insertText("First note", 1));

    expect(controller.session.session.draftSource).toBe("First note");
    expect(onUserSourceChange).toHaveBeenCalledExactlyOnceWith(
      "First note",
      expect.objectContaining({ source: "First note" }),
    );
    expect(view.dom.classList.contains("is-empty")).toBe(false);
    expect(view.dom.hasAttribute("aria-placeholder")).toBe(false);
  });

  it("destroys only its own view", () => {
    const { controller, host, view } = mountEditor();
    controller.destroy();
    expect(controller.view).toBeNull();
    expect(view.isDestroyed).toBe(true);
    expect(host.childNodes).toHaveLength(0);
  });

  it("updates external source in the same mounted view without a save callback", () => {
    const { controller, onUserSourceChange, view } = mountEditor();
    expect(
      controller.receiveExternalSource({ source: "# Agent update\n", revision: "sha256:agent" }),
    ).toBe("adopted");

    expect(controller.view).toBe(view);
    expect(view.dom.querySelector("h1")?.textContent).toBe("Agent update");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("synchronizes rich selection by source block without creating a save", () => {
    const onUserSourceChange = vi.fn();
    const onSelectionSourceOffsetChange = vi.fn();
    const source = "# First\n\n## Second\n";
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
      onSelectionSourceOffsetChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const secondSourceOffset = source.indexOf("## Second");

    expect(controller.navigateToSourceOffset(secondSourceOffset + 4)).toBe(true);
    expect(view.state.selection.$from.parent.textContent).toBe("Second");
    expect(onUserSourceChange).not.toHaveBeenCalled();

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(onSelectionSourceOffsetChange).toHaveBeenLastCalledWith(0);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("keeps rendered math visible while the rich document is editable", async () => {
    const onUserSourceChange = vi.fn();
    const source = [
      "Dollar $E=mc^2$ and backslash \\(a+b\\).",
      "",
      "$$",
      "\\int_0^1 x \\, dx",
      "$$",
      "",
      "\\[",
      "pH=6.1+\\log\\left(\\frac{HCO_3^-}{0.03\\times pCO_2}\\right)",
      "\\]",
      "",
    ].join("\n");
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Scientific Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(view.editable).toBe(true);
    expect(view.dom.querySelectorAll("[data-scient-markdown-math]")).toHaveLength(4);
    await vi.waitFor(() => {
      expect(view.dom.querySelectorAll(".scient-markdown-math-render .katex")).toHaveLength(4);
      expect(view.dom.querySelectorAll(".scient-markdown-math-render .katex-display")).toHaveLength(
        2,
      );
    });
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    const inlineMath = view.dom.querySelector<HTMLElement>('[data-scient-markdown-math="inline"]');
    const displayMath = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-math="display"]',
    );
    const inlineSource = inlineMath?.querySelector<HTMLInputElement>("input");
    const displaySource = displayMath?.querySelector<HTMLTextAreaElement>("textarea");

    inlineMath
      ?.querySelector<HTMLElement>(".scient-markdown-math-render")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(inlineSource?.hidden).toBe(false);
    expect(document.activeElement).toBe(inlineSource);

    displayMath
      ?.querySelector<HTMLElement>(".scient-markdown-math-render")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(inlineSource?.hidden).toBe(true);
    expect(displaySource?.hidden).toBe(false);
    expect(document.activeElement).toBe(displaySource);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("retains the last valid rendered equation during invalid TeX edits", async () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "$$\nE=mc^2\n$$\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Scientific Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    await vi.waitFor(() => {
      expect(view.dom.querySelector("[data-scient-markdown-math-validity='valid']")).not.toBeNull();
    });
    const renderedBefore = view.dom.querySelector(".scient-markdown-math-render")?.textContent;
    const equation = view.state.doc.firstChild;
    expect(equation?.type.name).toBe("display_math");
    view.dispatch(
      view.state.tr.setNodeMarkup(0, undefined, {
        ...equation!.attrs,
        tex: "\\frac{",
      }),
    );

    await vi.waitFor(() => {
      expect(
        view.dom.querySelector("[data-scient-markdown-math-source-state='retained']"),
      ).not.toBeNull();
      expect(
        view.dom.querySelector("[data-scient-markdown-math-validity='invalid']"),
      ).not.toBeNull();
    });
    expect(view.dom.querySelector(".scient-markdown-math-render")?.textContent).toBe(
      renderedBefore,
    );
    expect(view.dom.querySelector(".scient-markdown-math-retained")?.textContent).toContain(
      "last valid equation",
    );
    expect(controller.session.session.draftSource).toContain("\\frac{");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("renders task, wiki, and raw-source nodes and gates task changes by mode", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: '- [x] Done\n\nSee [[Methods|protocol]].\n\n<section data-x="1">raw</section>\n',
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const checkbox = view.dom.querySelector<HTMLInputElement>(".scient-markdown-task-checkbox");

    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
    expect(checkbox?.getAttribute("aria-label")).toBe("Mark task incomplete: Done");
    expect(view.dom.querySelector("[data-scient-markdown-wiki-link]")?.textContent).toContain(
      "protocol",
    );
    expect(
      view.dom.querySelector<HTMLTextAreaElement>(
        "[data-scient-markdown-source-island] .scient-markdown-source-island-editor",
      )?.value,
    ).toContain("raw");

    controller.setMode("write");
    expect(checkbox?.disabled).toBe(false);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(onUserSourceChange.mock.calls[0]?.[0]).toContain("- [ ] Done");
    expect(checkbox?.getAttribute("aria-label")).toBe("Mark task complete: Done");
  });

  it("keeps wiki-link editing out of the document DOM until a picker choice is committed", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Method]].\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    let wikiPosition: number | null = null;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "wiki_link") wikiPosition = position;
    });
    expect(wikiPosition).not.toBeNull();
    const wikiNode = view.state.doc.nodeAt(wikiPosition!);
    expect(wikiNode).not.toBeNull();
    expect(
      view.someProp("handleDoubleClickOn", (handler) =>
        handler(
          view,
          wikiPosition!,
          wikiNode!,
          wikiPosition!,
          new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }),
          true,
        ),
      ),
    ).toBe(true);

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection).toMatchObject({ from: wikiPosition, to: wikiPosition! + 1 });
    expect(controller.getSnapshot()).toMatchObject({
      selectedWikiLinkTarget: "Method",
      wikiLinkEditRequest: 1,
    });
    expect(view.dom.querySelector("input")).toBeNull();
    expect(view.dom.querySelector("datalist")).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(view.state.doc.nodeAt(wikiPosition!)?.attrs.target).toBe("Method");

    expect(controller.setWikiLink("שיטה")).toBe(true);
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(controller.session.session.draftSource).toContain("[[שיטה]]");
  });

  it("opens wiki links with one click and reserves deliberate selection for editing", async () => {
    vi.useFakeTimers();
    const onOpenWikiLink = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Methods|protocol]].\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onOpenWikiLink,
      wikiLinkTargetExists: (target) => target === "Methods",
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const link = host.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]");
    expect(link?.getAttribute("role")).toBe("link");
    expect(link?.tabIndex).toBe(0);
    expect(link?.dataset.scientMarkdownWikiTargetState).toBe("present");

    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(onOpenWikiLink).toHaveBeenCalledExactlyOnceWith("Methods", link);
    controller.setMode("write");
    expect(link?.tabIndex).toBe(-1);
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(onOpenWikiLink).toHaveBeenCalledTimes(1);
    expect(host.querySelector("input")).toBeNull();
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenWikiLink).toHaveBeenCalledTimes(2);

    link!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onOpenWikiLink).toHaveBeenCalledTimes(3);

    let wikiPosition: number | null = null;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "wiki_link") wikiPosition = position;
    });
    const wikiNode = view.state.doc.nodeAt(wikiPosition!);
    expect(wikiNode).not.toBeNull();
    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    link!.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    expect(view.editable).toBe(true);
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 2 }));
    expect(
      view.someProp("handleDoubleClickOn", (handler) =>
        handler(
          view,
          wikiPosition!,
          wikiNode!,
          wikiPosition!,
          new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }),
          true,
        ),
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenWikiLink).toHaveBeenCalledTimes(3);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection).toMatchObject({
      from: wikiPosition,
      to: wikiPosition! + wikiNode!.nodeSize,
    });
    expect(controller.getSnapshot()).toMatchObject({
      canSetWikiLink: true,
      selectedWikiLinkTarget: "Methods",
      wikiLinkEditRequest: 1,
    });
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("datalist")).toBeNull();
    controller.acknowledgeWikiLinkEditRequest(1);
    expect(controller.getSnapshot().wikiLinkEditRequest).toBe(0);
    link!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 1,
        clientX: 20,
        clientY: 10,
      }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenWikiLink).toHaveBeenCalledTimes(3);

    controller.setMode("read");
    const currentLink = host.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]");
    expect(currentLink?.tabIndex).toBe(0);
    currentLink!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onOpenWikiLink).toHaveBeenCalledTimes(4);

    controller.setMode("write");
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, wikiPosition!, wikiPosition! + wikiNode!.nodeSize),
      ),
    );
    expect(controller.setWikiLink("Missing")).toBe(true);
    expect(currentLink?.dataset.scientMarkdownWikiTargetState).toBe("missing");
    expect(currentLink?.getAttribute("aria-invalid")).toBe("true");
    vi.useRealTimers();
  });

  it("opens safe document links while preserving double-click and drag selection", async () => {
    vi.useFakeTimers();
    const onLocalHeadingOpened = vi.fn();
    const onOpenLink = vi.fn();
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Results\n\n[external](https://example.com) and [jump](#results).\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onLocalHeadingOpened,
      onOpenLink,
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a[href]")];
    expect(links).toHaveLength(2);

    links[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com", links[0]);
    links[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(view.state.selection.$from.parent.type.name).toBe("heading");
    expect(onLocalHeadingOpened).toHaveBeenCalledOnce();
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.setMode("write");
    links[0]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: 1 }),
    );
    expect(onOpenLink).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenLink).toHaveBeenCalledTimes(2);

    links[0]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: 1 }),
    );
    links[0]!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    links[0]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: 2 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenLink).toHaveBeenCalledTimes(2);

    links[0]!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 10 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    links[0]!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: 1 }),
    );
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenLink).toHaveBeenCalledTimes(2);

    links[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, ctrlKey: true }));
    expect(onOpenLink).toHaveBeenCalledTimes(3);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("opens a GFM bare URL recognized by the established preview", () => {
    const onOpenLink = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Source: https://example.com/reference.\n",
      revision: "sha256:before",
      mode: "read",
      ariaLabel: "Markdown document",
      onOpenLink,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    controller.mount(host);
    const link = host.querySelector<HTMLAnchorElement>("a[href]");

    expect(link?.href).toBe("https://example.com/reference");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com/reference", link);
  });

  it("reports a missing same-document heading through the clicked link without mutating", () => {
    const onOpenLink = vi.fn();
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Existing\n\n[Missing section](#not-here).\n",
      revision: "r0",
      mode: "read",
      ariaLabel: "Missing heading",
      onOpenLink,
      onUserSourceChange,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const link = view.dom.querySelector<HTMLAnchorElement>("a[href='#not-here']")!;
    const sourceBefore = controller.session.session.draftSource;

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));

    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("#not-here", link);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(sourceBefore);
  });

  it("hides the duplicate render while a plain code block is being edited", async () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "```python linenos\nprint('result')\n```\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const rendered = view.dom.querySelector<HTMLElement>(".scient-markdown-code-render");

    expect(rendered?.textContent).toContain("print('result')");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    await vi.waitFor(() => {
      expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).not.toBeNull();
    });
    await vi.waitFor(() => {
      const editableCode = view.dom.querySelector<HTMLElement>(
        ".scient-markdown-code-editor .cm-line",
      );
      expect(editableCode?.textContent).toBe("print('result')");
      expect(editableCode?.querySelector("span")).not.toBeNull();
    });
    const lightTokenClass = view.dom.querySelector<HTMLElement>(
      ".scient-markdown-code-editor .cm-line span",
    )?.className;
    const lightEditorClass = view.dom.querySelector<HTMLElement>(
      ".scient-markdown-code-editor .cm-editor",
    )?.className;
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => {
      expect(
        view.dom.querySelector<HTMLElement>(".scient-markdown-code-editor .cm-editor")?.className,
      ).not.toBe(lightEditorClass);
      expect(
        view.dom.querySelector<HTMLElement>(".scient-markdown-code-editor .cm-line span")
          ?.className,
      ).not.toBe(lightTokenClass);
    });
    expect(rendered?.hidden).toBe(true);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("keeps a rich visual interactive and opens source only through an authoring action", async () => {
    const onUserSourceChange = vi.fn();
    const showRichFenceContextMenu = vi.fn(async () => "edit-source" as const);
    const controller = new ScientMarkdownEditorView({
      source: "```mermaid title=Flow\ngraph LR\n  A --> B\n```\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
      showRichFenceContextMenu,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    await vi.waitFor(() => {
      expect(view.dom.querySelector("[data-scient-markdown-rich-fence='mermaid']")).not.toBeNull();
      expect(view.dom.querySelector(".scient-mermaid-card")).not.toBeNull();
    });
    const richFence = view.dom.querySelector<HTMLElement>(
      "[data-scient-markdown-rich-fence='mermaid']",
    )!;
    expect(richFence.classList.contains("scient-markdown-code-block")).toBe(true);
    expect(richFence.querySelector(".scient-markdown-code-header")).not.toBeNull();
    expect(richFence.querySelector("[data-scient-visual-card]")).not.toBeNull();
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    await Promise.resolve();
    expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).toBeNull();

    const visual = richFence.querySelector<HTMLElement>("[data-scient-visual-card]")!;
    visual.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 19,
        clientY: 31,
      }),
    );
    await vi.waitFor(() => {
      expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).not.toBeNull();
    });
    expect(showRichFenceContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 19, y: 31 });
    expect(view.dom.querySelector(".scient-mermaid-card")).not.toBeNull();
    expect(richFence.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(
      false,
    );
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("retains the last valid scientific preview during invalid source edits", async () => {
    // happy-dom does not calculate intersections. Exercise the supported
    // no-observer fallback so this mounted fence can validate its live source.
    vi.stubGlobal("IntersectionObserver", undefined);
    const controller = new ScientMarkdownEditorView({
      source: '```plotly\n{"data":[{"x":[1],"y":[2]}]}\n```\n',
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: vi.fn(),
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    await vi.waitFor(() => {
      expect(view.dom.querySelector("[data-scient-rich-fence-validity='valid']")).not.toBeNull();
    });
    const codeBlock = view.state.doc.firstChild;
    expect(codeBlock?.type.name).toBe("code_block");
    view.dispatch(
      view.state.tr.replaceWith(1, codeBlock!.nodeSize - 1, view.state.schema.text('{"data":[')),
    );

    await vi.waitFor(() => {
      const retained = view.dom.querySelector("[data-scient-rich-fence-source-state='retained']");
      expect(retained).not.toBeNull();
      expect(retained?.textContent).toContain("Preview kept at the last valid version.");
    });
  });

  it("inserts an uploaded image only after the server returns its portable path", async () => {
    let resolveUpload: (value: { readonly src: string; readonly alt: string }) => void = () =>
      undefined;
    const uploadPromise = new Promise<{ readonly src: string; readonly alt: string }>((resolve) => {
      resolveUpload = resolve;
    });
    const onUserSourceChange = vi.fn();
    const onImageUploadFailure = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Before image.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
      uploadImage: () => uploadPromise,
      onImageUploadFailure,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(controller.uploadImageFile(new File(["image"], "plot.png", { type: "image/png" }))).toBe(
      true,
    );
    expect(view.dom.querySelector("[data-scient-markdown-image-upload]")).not.toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();

    resolveUpload({ src: "assets/plot.png", alt: "Plot" });
    await vi.waitFor(() => {
      expect(view.dom.querySelector("img[src='assets/plot.png']")).not.toBeNull();
    });
    expect(view.dom.querySelector("[data-scient-markdown-image-upload]")).toBeNull();
    expect(controller.session.session.draftSource).toContain("![Plot](assets/plot.png)");
    expect(onUserSourceChange).toHaveBeenCalledTimes(1);
    expect(onImageUploadFailure).not.toHaveBeenCalled();
  });

  it("finds rich text across formatting boundaries without producing a save", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "alpha Alpha alphabet al**pha**\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    const shortcut = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    const handled = view.someProp("handleKeyDown", (handler) => handler(view, shortcut));
    expect(handled).toBe(true);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(controller.getSnapshot().findOpen).toBe(true);

    controller.configureFind({ query: "alpha", caseSensitive: false, wholeWord: false });
    expect(controller.getSnapshot().findMatchCount).toBe(4);
    controller.configureFind({ query: "alpha", caseSensitive: false, wholeWord: true });
    expect(controller.getSnapshot().findMatchCount).toBe(3);
    controller.navigateFind(1);
    expect(controller.getSnapshot().findActiveIndex).toBe(1);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.configureFind({ query: "Alpha", caseSensitive: true, wholeWord: true });
    expect(controller.getSnapshot().findMatchCount).toBe(1);
    expect(controller.replaceFind("Omega", false)).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.setFindOpen(false);
    expect(controller.getSnapshot().findOpen).toBe(false);
    expect(controller.getSnapshot().findQuery).toBe("");
    expect(controller.getSnapshot().findMatchCount).toBe(0);
  });

  it("replaces the current or every rich-view match as one user edit", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "alpha and alpha\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    controller.mount(host);

    controller.configureFind({ query: "alpha", caseSensitive: true, wholeWord: true });
    expect(controller.replaceFind("beta", false)).toBe(true);
    expect(onUserSourceChange).toHaveBeenCalledTimes(1);
    expect(onUserSourceChange.mock.lastCall?.[0]).toBe("beta and alpha\n");
    expect(controller.getSnapshot().findMatchCount).toBe(1);

    expect(controller.replaceFind("gamma", true)).toBe(true);
    expect(onUserSourceChange).toHaveBeenCalledTimes(2);
    expect(onUserSourceChange.mock.lastCall?.[0]).toBe("beta and gamma\n");
    expect(controller.getSnapshot().findMatchCount).toBe(0);
  });

  it("builds a nested document outline and navigates without saving", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Intro\n\nText\n\n> ## Nested methods\n> Body\n\n### Results\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(controller.getSnapshot().outlineItems).toEqual([
      expect.objectContaining({ level: 1, text: "Intro" }),
      expect.objectContaining({ level: 2, text: "Nested methods" }),
      expect.objectContaining({ level: 3, text: "Results" }),
    ]);
    const nested = controller.getSnapshot().outlineItems[1];
    expect(nested).toBeDefined();
    expect(controller.navigateToOutline(nested!.position)).toBe(true);
    expect(view.state.selection.$from.parent.type.name).toBe("heading");
    expect(view.state.selection.$from.parent.textContent).toBe("Nested methods");
    expect(controller.getSnapshot().outlineActiveIndex).toBe(1);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("moves, duplicates, deletes, and undoes source-faithful top-level blocks", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# One\n\n__two__\n\n-   three\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const secondBlockPosition = view.state.doc.child(0).nodeSize + 1;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, secondBlockPosition)),
    );

    expect(controller.getSnapshot()).toMatchObject({
      canDeleteBlock: true,
      canDuplicateBlock: true,
      canMoveBlockDown: true,
      canMoveBlockUp: true,
    });
    expect(controller.executeBlock("move-up")).toBe(true);
    expect(controller.session.session.draftSource).toBe("__two__\n\n# One\n\n-   three\n");

    expect(controller.executeBlock("duplicate")).toBe(true);
    expect(controller.session.session.draftSource).toBe(
      "__two__\n\n__two__\n\n# One\n\n-   three\n",
    );

    expect(controller.executeBlock("delete")).toBe(true);
    expect(controller.session.session.draftSource).toBe("__two__\n\n# One\n\n-   three\n");
    expect(controller.execute("undo")).toBe(true);
    expect(controller.session.session.draftSource).toBe(
      "__two__\n\n__two__\n\n# One\n\n-   three\n",
    );
    expect(onUserSourceChange).toHaveBeenCalledTimes(4);
  });

  it("moves a multi-block selection as one structural edit", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "One\n\n__Two__\n\n-   Three\n\nFour\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const secondStart = view.state.doc.child(0).nodeSize;
    const thirdStart = secondStart + view.state.doc.child(1).nodeSize;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, secondStart + 1, thirdStart + 2),
      ),
    );

    expect(controller.executeBlock("move-down")).toBe(true);
    expect(controller.session.session.draftSource).toBe("One\n\nFour\n\n__Two__\n\n-   Three\n");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("pins leading front matter while leaving explicit deletion available", () => {
    const source = "---\ntitle: Safe\n---\n\n# Heading\n\nBody\n";
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(view.state.selection.$from.parent.type.name).toBe("heading");
    expect(controller.getSnapshot().canMoveBlockUp).toBe(false);
    expect(controller.executeBlock("move-up")).toBe(false);
    expect(controller.session.session.draftSource).toBe(source);

    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    expect(controller.getSnapshot()).toMatchObject({
      canDeleteBlock: true,
      canDuplicateBlock: false,
      canMoveBlockDown: false,
      canMoveBlockUp: false,
    });
    expect(controller.executeBlock("duplicate")).toBe(false);
    expect(controller.executeBlock("move-down")).toBe(false);
    expect(controller.session.session.draftSource).toBe(source);
  });

  it("deletes the only block into an editable empty paragraph", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Only block\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    expect(controller.executeBlock("delete")).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(controller.session.session.draftSource).toBe("\n");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("runs formatting and slash commands through user transactions", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Text\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    expect(controller.execute("bold")).toBe(true);
    expect(onUserSourceChange.mock.lastCall?.[0]).toBe("**Text**\n");
    expect(controller.getSnapshot().activeMarks).toContain("strong");

    controller.replaceUserSource("/tab\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    expect(controller.getSnapshot().slashQuery).toBe("tab");
    expect(controller.executeSlashCommand("table")).toBe(true);
    expect(view.dom.querySelector("table")).not.toBeNull();
    expect(onUserSourceChange.mock.lastCall?.[0]).toContain("|  |  |  |");
  });

  it("implements the inline-code and strikethrough shortcuts advertised by the dock", () => {
    const controller = new ScientMarkdownEditorView({
      source: "Some text here.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 10)));

    for (const event of [
      new KeyboardEvent("keydown", { key: "e", ctrlKey: true }),
      new KeyboardEvent("keydown", { key: "x", ctrlKey: true, shiftKey: true }),
    ]) {
      expect(view.someProp("handleKeyDown", (handler) => handler(view, event))).toBe(true);
    }
    const active = new Set(controller.getSnapshot().activeMarks);
    expect(active).toEqual(new Set(["code", "strike"]));
    expect(controller.session.session.draftSource).toBe("Some `~~text~~` here.\n");
  });

  it.each([
    ["bold", "b", false, "strong"],
    ["italic", "i", false, "em"],
    ["inline code", "e", false, "code"],
    ["strikethrough", "x", true, "strike"],
  ] as const)(
    "toggles %s from a real DOM shortcut as one undoable command",
    (_name, key, shiftKey, mark) => {
      const controller = new ScientMarkdownEditorView({
        source: "Text\n",
        revision: "sha256:before",
        mode: "write",
        ariaLabel: "Mark shortcut",
      });
      const host = document.createElement("div");
      document.body.append(host);
      mounted.push(controller);
      const view = controller.mount(host);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
      const press = () => {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          shiftKey,
        });
        view.dom.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      };

      press();
      expect(controller.getSnapshot().activeMarks).toContain(mark);
      const undo = new KeyboardEvent("keydown", {
        key: "z",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      view.dom.dispatchEvent(undo);
      expect(undo.defaultPrevented).toBe(true);
      expect(controller.session.session.draftSource).toBe("Text\n");
    },
  );

  it("routes real DOM selection, formatting, and history shortcuts exactly once", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Some text here.\n\nSecond paragraph.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Shortcut document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const dispatchShortcut = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        ...init,
      });
      view.dom.dispatchEvent(event);
      return event;
    };

    const selectAll = dispatchShortcut("a");
    expect(selectAll.defaultPrevented).toBe(true);
    expect(view.state.selection).toBeInstanceOf(AllSelection);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 10)));
    const bold = dispatchShortcut("b");
    expect(bold.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe(
      "Some **text** here.\n\nSecond paragraph.\n",
    );
    expect(onUserSourceChange).toHaveBeenCalledTimes(1);

    const undo = dispatchShortcut("z");
    expect(undo.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe("Some text here.\n\nSecond paragraph.\n");
    expect(onUserSourceChange).toHaveBeenCalledTimes(2);

    const redo = dispatchShortcut("z", { shiftKey: true });
    expect(redo.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe(
      "Some **text** here.\n\nSecond paragraph.\n",
    );
    expect(onUserSourceChange).toHaveBeenCalledTimes(3);

    dispatchShortcut("z");
    const alternateRedo = dispatchShortcut("y");
    expect(alternateRedo.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe(
      "Some **text** here.\n\nSecond paragraph.\n",
    );
    expect(onUserSourceChange).toHaveBeenCalledTimes(5);
  });

  it("routes familiar style, list, and clear-formatting keys through toolbar commands", () => {
    const controller = new ScientMarkdownEditorView({
      source: "Text\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Structural shortcuts",
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const dispatchShortcut = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        ...init,
      });
      view.dom.dispatchEvent(event);
      expect(event.defaultPrevented, `${key} must be editor-owned`).toBe(true);
    };

    dispatchShortcut("2", { altKey: true });
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.firstChild?.attrs.level).toBe(2);

    dispatchShortcut("0", { altKey: true });
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");

    dispatchShortcut("7", { shiftKey: true });
    expect(view.state.doc.firstChild?.type.name).toBe("ordered_list");

    controller.replaceUserSource("Text\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    expect(controller.execute("bold")).toBe(true);
    dispatchShortcut("\\");
    expect(controller.session.session.draftSource).toBe("Text\n");

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    const hebrewLayoutBold = new KeyboardEvent("keydown", {
      key: "נ",
      code: "KeyB",
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    Object.defineProperty(hebrewLayoutBold, "keyCode", { value: 66 });
    view.dom.dispatchEvent(hebrewLayoutBold);
    expect(hebrewLayoutBold.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe("**Text**\n");
  });

  it("covers every advertised heading, list, hard-break, and block-action chord", () => {
    const controller = new ScientMarkdownEditorView({
      source: "First\n\nSecond\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Command shortcut matrix",
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        ...init,
      });
      view.dom.dispatchEvent(event);
      expect(event.defaultPrevented, `${JSON.stringify({ key, ...init })} must be handled`).toBe(
        true,
      );
    };

    for (let level = 1; level <= 6; level += 1) {
      controller.replaceUserSource("Text\n");
      press(String(level), { altKey: true });
      expect(view.state.doc.firstChild?.type.name).toBe("heading");
      expect(view.state.doc.firstChild?.attrs.level).toBe(level);
    }

    for (const [key, nodeName, task] of [
      ["7", "ordered_list", false],
      ["8", "bullet_list", false],
      ["9", "bullet_list", true],
    ] as const) {
      controller.replaceUserSource("Text\n");
      press(key, { shiftKey: true });
      expect(view.state.doc.firstChild?.type.name).toBe(nodeName);
      expect(view.state.doc.firstChild?.firstChild?.attrs.taskChecked === false).toBe(task);
    }

    controller.replaceUserSource("Text\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    press("Enter", { ctrlKey: false, shiftKey: true });
    expect(controller.session.session.draftSource).toBe("Te\\\nxt\n");

    controller.replaceUserSource("First\n\nSecond\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)));
    press("ArrowUp", { altKey: true, ctrlKey: false });
    expect(controller.session.session.draftSource).toBe("Second\n\nFirst\n");
    press("ArrowDown", { altKey: true, ctrlKey: false });
    expect(controller.session.session.draftSource).toBe("First\n\nSecond\n");
    press("ArrowDown", { altKey: true, ctrlKey: false, shiftKey: true });
    expect(controller.session.session.draftSource).toBe("First\n\nSecond\n\nSecond\n");
  });

  it("uses identical code-block exit semantics for hard-break commands and shortcuts", () => {
    const source = "```ts\nconst value = 1;\n```\n";
    const run = (shortcut: boolean) => {
      const controller = new ScientMarkdownEditorView({
        source,
        revision: "sha256:before",
        mode: "write",
        ariaLabel: shortcut ? "Shortcut hard break" : "Command hard break",
      });
      const host = document.createElement("div");
      document.body.append(host);
      mounted.push(controller);
      const view = controller.mount(host);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));

      if (shortcut) {
        const event = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        });
        view.dom.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      } else {
        expect(controller.execute("hard-break")).toBe(true);
      }

      expect(view.state.doc.firstChild?.type.name).toBe("code_block");
      expect(view.state.doc.firstChild?.textContent).toBe("const value = 1;");
      expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
      const result = controller.session.session.draftSource;
      expect(controller.execute("undo")).toBe(true);
      expect(controller.session.session.draftSource).toBe(source);
      return result;
    };

    expect(run(true)).toBe(run(false));
  });

  it("leaves native clipboard shortcuts native and matches editor UI keys exactly", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Clipboard text.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Clipboard shortcuts",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 10)));

    for (const [key, shiftKey] of [
      ["c", false],
      ["x", false],
      ["v", false],
      ["v", true],
    ] as const) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        shiftKey,
      });
      view.dom.dispatchEvent(event);
      expect(event.defaultPrevented, `${key} must remain native`).toBe(false);
    }
    expect(controller.session.session.draftSource).toBe("Clipboard text.\n");
    expect(onUserSourceChange).not.toHaveBeenCalled();

    const shiftedFind = new KeyboardEvent("keydown", {
      key: "f",
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      shiftKey: true,
    });
    view.dom.dispatchEvent(shiftedFind);
    expect(shiftedFind.defaultPrevented).toBe(false);
    expect(controller.getSnapshot().findOpen).toBe(false);
  });

  it("applies GFM alignment to the complete selected table column", () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "| Group | Value |\n| --- | --- |\n| A | 2.4 |\n| B | 4.8 |\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    let selectedCellPosition = -1;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "table_cell" && node.textContent === "2.4") {
        selectedCellPosition = position;
        return false;
      }
      return true;
    });
    expect(selectedCellPosition).toBeGreaterThanOrEqual(0);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, selectedCellPosition + 2)),
    );

    expect(controller.execute("align-column-center")).toBe(true);
    expect(controller.getSnapshot().tableAlignment).toBe("center");
    const table = view.state.doc.firstChild;
    expect(table?.type.name).toBe("table");
    for (let row = 0; row < (table?.childCount ?? 0); row += 1) {
      expect(table?.child(row).child(1).attrs.alignment).toBe("center");
    }
    expect(controller.session.session.draftSource).toContain("| --- | :---: |");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("keeps a workspace image rendered while its portable source fields are edited", async () => {
    const onUserSourceChange = vi.fn();
    const resolveImageSource = vi.fn(async (source: string) => `https://asset.test/${source}`);
    const controller = new ScientMarkdownEditorView({
      source: '![Microscopy image](figures/cell.png "Cell culture")\n',
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
      resolveImageSource,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const image = view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render");

    await vi.waitFor(() => expect(image?.src).toContain("figures/cell.png"));
    expect(image?.alt).toBe("Microscopy image");
    expect(view.dom.querySelector(".scient-markdown-image-caption")?.textContent).toBe(
      "Cell culture",
    );
    expect(resolveImageSource).toHaveBeenCalledWith("figures/cell.png");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    expect(view.dom.querySelector<HTMLInputElement>("[aria-label='Image path']")?.value).toBe(
      "figures/cell.png",
    );
    expect(image?.hidden).toBe(false);
    const caption = view.dom.querySelector<HTMLInputElement>(
      "[aria-label='Image title or caption']",
    );
    expect(caption?.value).toBe("Cell culture");
    caption!.value = "Updated caption";
    caption!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(controller.session.session.draftSource).toContain('"Updated caption"');
    expect(image?.hidden).toBe(false);
    expect(resolveImageSource).toHaveBeenCalledOnce();
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("resolves repeated references to one workspace image independently", async () => {
    const resolveImageSource = vi.fn(async () => "https://asset.test/shared.png");
    const controller = new ScientMarkdownEditorView({
      source: "![First](./shared.png)\n\n![Second](./shared.png)\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Repeated images",
      resolveImageSource,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);

    await vi.waitFor(() => {
      const images = [
        ...view.dom.querySelectorAll<HTMLImageElement>(".scient-markdown-image-render"),
      ];
      expect(images).toHaveLength(2);
      expect(images.every((image) => image.src === "https://asset.test/shared.png")).toBe(true);
    });
    expect(resolveImageSource).toHaveBeenCalledTimes(2);
    expect(resolveImageSource).toHaveBeenNthCalledWith(1, "./shared.png");
    expect(resolveImageSource).toHaveBeenNthCalledWith(2, "./shared.png");
  });

  it("refreshes missing workspace images and wiki targets without changing the document", async () => {
    let resourcesAvailable = false;
    const onUserSourceChange = vi.fn();
    const resolveImageSource = vi.fn(async () =>
      resourcesAvailable ? "https://asset.test/created.png" : null,
    );
    const controller = new ScientMarkdownEditorView({
      source: "![Created later](figures/created.png)\n\nSee [[Created later]].\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "External resources",
      onUserSourceChange,
      resolveImageSource,
      wikiLinkTargetExists: () => resourcesAvailable,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const image = view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render")!;
    const placeholder = view.dom.querySelector<HTMLElement>(".scient-markdown-image-placeholder")!;
    const wikiLink = view.dom.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]")!;

    await vi.waitFor(() => expect(placeholder.textContent).toContain("Unable to resolve"));
    expect(wikiLink.dataset.scientMarkdownWikiTargetState).toBe("missing");

    resourcesAvailable = true;
    controller.refreshExternalPresentation("workspace");

    await vi.waitFor(() => expect(image.src).toBe("https://asset.test/created.png"));
    expect(image.hidden).toBe(false);
    expect(wikiLink.dataset.scientMarkdownWikiTargetState).toBe("present");
    expect(resolveImageSource).toHaveBeenCalledTimes(2);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(
      "![Created later](figures/created.png)\n\nSee [[Created later]].\n",
    );
  });

  it("clears stale image state when an unresolved path is removed", async () => {
    const controller = new ScientMarkdownEditorView({
      source: "![Missing](figures/missing.png)\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      resolveImageSource: vi.fn(async () => null),
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    const placeholder = view.dom.querySelector<HTMLElement>(".scient-markdown-image-placeholder");

    await vi.waitFor(() => expect(placeholder?.textContent).toContain("Unable to resolve"));
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    const source = view.dom.querySelector<HTMLInputElement>("[aria-label='Image path']");
    source!.value = "";
    source!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));

    expect(placeholder?.textContent).toBe("Choose an image path");
    expect(placeholder?.hidden).toBe(false);
    expect(view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render")?.hidden).toBe(
      true,
    );
  });

  it("keeps an image reference for alt edits but detaches after an explicit path edit", () => {
    const controller = new ScientMarkdownEditorView({
      source: "![Plot][figure]\n\n[figure]: old.png\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Reference image",
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    const alt = view.dom.querySelector<HTMLInputElement>("[aria-label='Image alternative text']")!;
    alt.value = "New description";
    alt.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(controller.session.session.draftSource).toContain("![New description][figure]");
    const path = view.dom.querySelector<HTMLInputElement>("[aria-label='Image path']")!;
    for (const value of ["chosen.png", "old.png"]) {
      path.value = value;
      path.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(controller.session.session.draftSource).toContain(`![New description](${value})`);
      expect(view.state.doc.firstChild!.firstChild!.attrs.referenceLabel).toBeNull();
    }
    const definitionPos = view.state.doc.firstChild!.nodeSize;
    view.dispatch(
      view.state.tr.setNodeMarkup(definitionPos, undefined, {
        ...view.state.doc.nodeAt(definitionPos)!.attrs,
        source: "[figure]: new.png",
      }),
    );
    expect(view.state.doc.firstChild!.firstChild!.attrs.src).toBe("old.png");
  });

  it("navigates from a numbered marker without focusing the directly editable definition", () => {
    const source = "Note[^lab].\n\n[^lab]: Collected twice.\n";
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Footnote reference",
      onUserSourceChange,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const reference = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-reference="footnote_reference"]',
    )!;
    const marker = reference.querySelector<HTMLButtonElement>("button")!;
    const definition = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-reference="footnote_definition"]',
    )!;
    const editor = definition.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(marker.textContent).toBe("1");
    expect(reference.querySelector("input, textarea")).toBeNull();
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("Collected twice.");
    marker.click();
    expect(view.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(document.activeElement).toBe(definition);
    expect(editor.hidden).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, button: 0 });
    editor.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(document.activeElement).toBe(editor);
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe("Collected twice.");
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.setMode("read");
    expect(editor.hidden).toBe(false);
    expect(editor.readOnly).toBe(true);
    expect(editor.tabIndex).toBe(-1);
    controller.setMode("write");
    expect(editor.hidden).toBe(false);
    expect(editor.readOnly).toBe(false);
    expect(editor.tabIndex).toBe(0);

    editor.value = "Collected again.\nWith details.";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(controller.session.session.draftSource).toBe(
      "Note[^lab].\n\n[^lab]: Collected again.\n    With details.\n",
    );
    expect(onUserSourceChange).toHaveBeenCalledOnce();

    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(view.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(editor.hidden).toBe(false);

    controller.setMode("read");
    editor.value = "ignored";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(controller.session.session.draftSource).toBe(
      "Note[^lab].\n\n[^lab]: Collected again.\n    With details.\n",
    );
  });

  it("uses a footnote-specific context menu for navigation, copying, and paired deletion", async () => {
    type Action = "go-to-footnote" | "copy-link" | "remove-reference" | "delete-footnote";
    let action: Action = "go-to-footnote";
    const showFootnoteContextMenu = vi.fn(async () => action);
    const onCopyLink = vi.fn();
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "One[^lab] two[^lab].\n\n[^lab]: Body.\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Footnote context menu",
      onCopyLink,
      onUserSourceChange,
      showFootnoteContextMenu,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const first = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-reference="footnote_reference"]',
    )!;
    const openMenu = (target: HTMLElement) =>
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 22,
          clientY: 31,
        }),
      );

    expect(openMenu(first)).toBe(false);
    const definition = view.dom.querySelector<HTMLElement>(".scient-markdown-footnote-definition")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(definition));
    expect(definition.querySelector<HTMLTextAreaElement>("textarea")?.hidden).toBe(false);
    expect(showFootnoteContextMenu).toHaveBeenLastCalledWith({
      canCopy: true,
      editable: true,
      hasDefinition: true,
      isFinalReference: false,
      position: { x: 22, y: 31 },
    });

    action = "copy-link";
    openMenu(first);
    await vi.waitFor(() =>
      expect(onCopyLink).toHaveBeenCalledExactlyOnceWith(
        { format: "link", value: "#scient-footnote-lab" },
        first,
      ),
    );
    expect(onUserSourceChange).not.toHaveBeenCalled();

    action = "remove-reference";
    openMenu(first);
    await vi.waitFor(() =>
      expect(controller.session.session.draftSource).toBe("One two[^lab].\n\n[^lab]: Body.\n"),
    );

    const remaining = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-reference="footnote_reference"]',
    )!;
    action = "delete-footnote";
    openMenu(remaining);
    await vi.waitFor(() => expect(controller.session.session.draftSource).toBe("One two.\n"));
    expect(view.dom.querySelector('[data-scient-markdown-reference^="footnote_"]')).toBeNull();
  });

  it("directly edits a compact reference definition and refreshes its derived link", () => {
    const source = 'Read [the source][shared].\n\n[shared]: ./old.md "Old title"\n';
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Reference definition",
      onUserSourceChange,
    });
    mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(host);
    const view = controller.mount(host);
    const definition = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-source-kind="definition"]',
    )!;
    const editor = definition.querySelector<HTMLTextAreaElement>("textarea")!;
    const linkBefore = view.dom.querySelector<HTMLAnchorElement>("a")!;

    expect(definition.querySelector("button")).toBeNull();
    expect(editor.hidden).toBe(false);
    expect(Number(editor.rows)).toBe(1);
    expect(editor.value).toBe('[shared]: ./old.md "Old title"');
    expect(linkBefore.getAttribute("href")).toBe("./old.md");
    expect(linkBefore.getAttribute("title")).toBe("Old title");
    expect(controller.session.session.draftSource).toBe(source);

    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.focus();
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(document.activeElement).toBe(editor);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(source);

    editor.value = '[shared]: ./new.md "New title"';
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(controller.session.session.draftSource).toBe(
      'Read [the source][shared].\n\n[shared]: ./new.md "New title"\n',
    );
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    const linkAfter = view.dom.querySelector<HTMLAnchorElement>("a")!;
    expect(linkAfter.getAttribute("href")).toBe("./new.md");
    expect(linkAfter.getAttribute("title")).toBe("New title");

    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(editor.hidden).toBe(false);
    expect(controller.session.session.draftSource).toContain('[shared]: ./new.md "New title"');
  });
});
