import { nativeShortcut } from "../../../../test/nativeShortcut";

import {
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "../../../index.css";
import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state";
import { DOMParser } from "prosemirror-model";
import { EditorView as CodeMirrorEditorView } from "@codemirror/view";

import type { EditorView } from "prosemirror-view";
import { getScientKatexRuntimePromise } from "~/scient/math/ScientMath";
import { scientMarkdownSchema } from "./schema";

import { ScientMarkdownEditorView } from "./view";

// Mod means Command on the native macOS browser and Control on other hosts.

/**
 * An item of the menu open now, once rendered. A menu that is closing stays mounted
 * until its exit finishes, so an item found in the whole document can be a stale one.
 */
async function openMenuItem(label: string): Promise<HTMLElement> {
  const find = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menu"]:not([data-closed]) [role="menuitem"]',
      ),
    ].find((item) => item.textContent === label);
  await expect.poll(find).toBeDefined();
  return find()!;
}

describe("ScientMarkdownEditorView", () => {
  it("keeps a refused field edit, selection, and Undo across a view remount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const onWritebackRefusal = vi.fn();
    const source = "# Result [@smith]\n\nTail\n";
    const first = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      ariaLabel: "Document",
      mode: "write",
      onUserSourceChange,
      onWritebackRefusal,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(first);
    const view = first.mount(host);
    let citationPosition = -1;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "citation") citationPosition = position;
    });
    expect(citationPosition).toBeGreaterThan(0);
    await act(() =>
      view.dispatch(view.state.tr.setNodeAttribute(citationPosition, "source", "@smith\n@jones")),
    );
    const pending = first.session.pendingWriteback;
    expect(pending).not.toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(first.session.session.draftSource).toBe(source);
    const retainedState = first.session.state;
    first.destroy();
    const second = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      ariaLabel: "Document",
      mode: "write",
      onUserSourceChange,
      onWritebackRefusal,
    });
    second.restorePendingWriteback(pending!);
    _fixture.mounted.push(second);
    const nextHost = document.createElement("div");
    document.body.append(_ownDOM(_fixture, nextHost));
    second.mount(nextHost);
    expect(second.session.state).toBe(retainedState);
    expect(second.session.state.doc.nodeAt(citationPosition)?.attrs.source).toBe("@smith\n@jones");
    await act(() => expect(second.executeKeyboardCommand("markdown.undo")).toBe(true));
    expect(second.session.pendingWriteback).toBeNull();
    expect(second.session.state.doc.nodeAt(citationPosition)?.attrs.source).toBe("@smith");
    expect(second.session.session.draftSource).toBe(source);
    expect(onWritebackRefusal).toHaveBeenLastCalledWith(null);
  });
  it.each(["ltr", "rtl"])("preserves explicit %s direction through DOM parsing", async (dir) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const host = document.createElement("div");
    host.innerHTML = `<p dir="${dir}">שלום world</p><h2 dir="${dir}">English עברית</h2><p dir="auto">Auto</p>`;
    const doc = DOMParser.fromSchema(scientMarkdownSchema).parse(host);
    expect(doc.child(0).attrs.dir).toBe(dir);
    expect(doc.child(1).attrs.dir).toBe(dir);
    expect(doc.child(2).attrs.dir).toBeNull();
  });

  async function _cleanupFixture0(_fixture: _Fixture) {
    await act(() => _fixture.mounted.splice(0).forEach((controller) => controller.destroy()));
    _clearOwnedDOM(_fixture);
    document.documentElement.classList.remove("dark");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }

  function mountEditor(_fixture: _Fixture) {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Heading\n\n- one\n  - nested\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    return { controller, host, onUserSourceChange, view: controller.mount(host) };
  }

  async function openImageDetails(view: EditorView, position = 1): Promise<HTMLInputElement> {
    await act(() => {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
      view.dom.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          nativeShortcut({ key: "Enter", bubbles: true, cancelable: true }),
        ),
      );
    });
    const source = document.querySelector<HTMLInputElement>("[aria-label='Image source']");
    expect(source).not.toBeNull();
    return source!;
  }

  it("still observes prose edits and renders authored attributes behind the presentation guard", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controller } = mountEditor(_fixture);
    controller.setMode("write");
    const heading = view.dom.querySelector("h1")!;
    await act(async () => {
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(heading, { childList: true });
        heading.textContent = "Changed heading";
      });
      (view as EditorView & { domObserver: { flush: () => void } }).domObserver.flush();
    });
    expect(view.state.doc.firstChild?.textContent).toBe("Changed heading");
    expect(controller.session.session.draftSource).toContain("Changed heading");
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { level: 2, dir: "rtl" }));
    expect(view.dom.querySelector("h2")?.getAttribute("dir")).toBe("rtl");
    expect(view.dom.querySelector("h2")?.textContent).toBe("Changed heading");
  });

  async function changeImageDetail(input: HTMLInputElement, value: string): Promise<void> {
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
  }

  async function applyImageDetails(input: HTMLInputElement): Promise<void> {
    await act(() => {
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function nativeImageUrl(source: string) {
    const url = new URL("/test/fixtures/assets/0001.png", window.location.href);
    url.hash = source;
    return url.href;
  }

  async function completeImageLoad(image: HTMLImageElement): Promise<void> {
    await image.decode();
    expect(image.complete).toBe(true);
    expect(image.naturalWidth).toBe(16);
    await act(() => {});
  }

  it("edits front matter through one persistent source surface without changing adjacent Markdown", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "---\ntitle: Before\n---\n\nBody\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Front matter",
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));

    const editorHost = view.dom.querySelector<HTMLElement>(
      ".scient-markdown-source-island-code-editor",
    )!;
    const editor = CodeMirrorEditorView.findFromDOM(editorHost)!;
    const editorContent = editorHost.querySelector<HTMLElement>(".cm-content")!;
    expect(view.dom.querySelector(".scient-markdown-source-island-preview")).toBeNull();
    expect(editorHost.hidden).toBe(false);
    expect(editorContent.getAttribute("contenteditable")).toBe("true");

    const enter = new KeyboardEvent(
      "keydown",
      nativeShortcut({ key: "Enter", bubbles: true, cancelable: true }),
    );
    view.dom.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editorContent);

    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: "---\ntitle: After\n---",
      },
    });

    expect(controller.session.session.draftSource).toBe("---\ntitle: After\n---\n\nBody\n");
    expect(editor.state.doc.toString()).toBe("---\ntitle: After\n---");

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(view.dom.querySelector(".scient-markdown-source-island-code-editor")).toBe(editorHost);
    expect(editorHost.hidden).toBe(false);

    controller.setMode("read");
    expect(editorContent.getAttribute("contenteditable")).toBe("false");
    controller.setMode("write");
    expect(editorContent.getAttribute("contenteditable")).toBe("true");
  });

  it.each(["caret", "selection"])(
    "updates and removes an existing link with a %s",
    async (kind) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const controller = new ScientMarkdownEditorView({
        source: "[Example](https://old.example)\n",
        revision: "r0",
        mode: "write",
        ariaLabel: "Link",
      });
      _fixture.mounted.push(controller);
      const host = document.createElement("div");
      document.body.append(_ownDOM(_fixture, host));
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
    },
  );

  it("right-clicks an ordinary link into its existing editor and unlink command", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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

  it("creates a link to a filename with spaces that remains a link on reopen", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, view } = mountEditor(_fixture);
    controller.setMode("write");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 8)));
    expect(controller.setLink("Other notes.md")).toBe(true);
    const reopened = new ScientMarkdownEditorView({
      source: controller.session.session.draftSource,
      revision: "r1",
      ariaLabel: "Reopened",
    });
    _fixture.mounted.push(reopened);
    expect(reopened.session.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe(
      "Other%20notes.md",
    );
  });

  it("updates a whole caret link across inline formatting without changing adjacent links", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "[one **two** three](old.md) [next](next.md)\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Links",
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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

  it("updates only the selected portion of a link or mixed link/plain text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "[Example](old.md) plain\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Links",
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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

  it("keeps a single text row visible when its direction changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "Only row.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);

    expect(controller.execute("direction-ltr")).toBe(true);
    expect(view.dom.querySelector("p[dir='ltr']")?.textContent).toBe("Only row.");

    expect(controller.execute("direction-rtl")).toBe(true);
    expect(view.dom.querySelector("p[dir='rtl']")?.textContent).toBe("Only row.");
    expect(view.state.doc.textContent).toBe("Only row.");
  });

  it("anchors the selection toolbar only to inline text selections", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, view } = mountEditor(_fixture);
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
    document.body.append(_ownDOM(_fixture, codeHost));
    _fixture.mounted.push(codeController);
    const codeView = codeController.mount(codeHost);
    codeView.dispatch(codeView.state.tr.setSelection(NodeSelection.create(codeView.state.doc, 0)));
    expect(codeController.selectionToolbarAnchor()).toBeNull();
  });

  it("turns an inline text selection into a labeled wiki link", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "Selected words.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9)));

    expect(controller.setWikiLink(" Methods/Protocol ")).toBe(true);
    expect(controller.session.session.draftSource).toBe("[[Methods/Protocol|Selected]] words.\n");
    expect(view.dom.querySelector("[data-scient-markdown-wiki-link]")?.textContent).toContain(
      "Selected",
    );
  });

  it("links a trimmed Hebrew pointer selection without consuming its surrounding spaces", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("retargets a deliberately selected wiki-link label", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "See [[Methods|the method]] next.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("removes a deliberately selected wiki link without losing its visible label", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Methods|the method]] and [[Results]].\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("keeps one mounted view and document through 100 read/write cycles", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, host, onUserSourceChange, view } = mountEditor(_fixture);
    const documentNode = view.state.doc;
    const renderedHeading = view.dom.querySelector("h1");
    const sourceBefore = controller.session.session.draftSource;
    const revisionBefore = controller.session.session.baselineRevision;
    host.style.cssText = "height: 100px; overflow-y: auto";
    view.dom.style.minHeight = "500px";
    host.scrollTop = 147;
    expect(host.scrollTop).toBe(147);
    const geometryBefore = view.dom.getBoundingClientRect().toJSON();
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

  it("activates the existing rendered document and emits only a real user edit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, onUserSourceChange, view } = mountEditor(_fixture);
    const renderedHeading = view.dom.querySelector("h1");
    expect(renderedHeading?.textContent).toBe("Heading");

    controller.setMode("write");
    expect(view.dom.querySelector("h1")).toBe(renderedHeading);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    view.dispatch(view.state.tr.insertText("Updated ", 1, 1));
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(onUserSourceChange.mock.calls[0]?.[0]).toContain("# Updated Heading");
  });

  it("opens an empty file with a focused caret and accepts the first text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "",
      revision: "sha256:empty",
      mode: "write",
      ariaLabel: "Empty Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("destroys only its own view", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, host, view } = mountEditor(_fixture);
    controller.destroy();
    expect(controller.view).toBeNull();
    expect(view.isDestroyed).toBe(true);
    expect(host.childNodes).toHaveLength(0);
  });

  it("updates external source in the same mounted view without a save callback", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, onUserSourceChange, view } = mountEditor(_fixture);
    expect(
      controller.receiveExternalSource({ source: "# Agent update\n", revision: "sha256:agent" }),
    ).toBe("adopted");

    expect(controller.view).toBe(view);
    expect(view.dom.querySelector("h1")?.textContent).toBe("Agent update");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("synchronizes rich selection by source block without creating a save", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    let view!: EditorView;
    // Loading the runtime and committing the Suspense content are separate
    // steps. Flush both before asserting the visible equation DOM.
    await act(async () => {
      view = controller.mount(host);
      await getScientKatexRuntimePromise();
    });

    expect(view.editable).toBe(true);
    expect(view.dom.querySelectorAll("[data-scient-markdown-math]")).toHaveLength(4);
    expect(view.dom.querySelectorAll(".scient-markdown-math-render .katex")).toHaveLength(4);
    expect(view.dom.querySelectorAll(".scient-markdown-math-render .katex-display")).toHaveLength(
      2,
    );
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    const inlineMath = view.dom.querySelector<HTMLElement>('[data-scient-markdown-math="inline"]');
    const displayMath = view.dom.querySelector<HTMLElement>(
      '[data-scient-markdown-math="display"]',
    );
    const inlineSource = inlineMath?.querySelector<HTMLTextAreaElement>("textarea");
    const displaySource = displayMath?.querySelector<HTMLTextAreaElement>("textarea");

    inlineMath
      ?.querySelector<HTMLElement>(".scient-markdown-math-render")
      ?.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(inlineSource?.hidden).toBe(false);
    expect(document.activeElement).toBe(inlineSource);

    displayMath
      ?.querySelector<HTMLElement>(".scient-markdown-math-render")
      ?.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(inlineSource?.hidden).toBe(true);
    expect(displaySource?.hidden).toBe(false);
    expect(document.activeElement).toBe(displaySource);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("retains the last valid rendered equation during invalid TeX edits", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "$$\nE=mc^2\n$$\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Scientific Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    let view!: EditorView;
    await act(async () => {
      view = controller.mount(host);
      await getScientKatexRuntimePromise();
    });
    expect(view.dom.querySelector("[data-scient-markdown-math-validity='valid']")).not.toBeNull();
    const renderedEquation = view.dom.querySelector(".scient-markdown-math-render .katex");
    expect(renderedEquation).not.toBeNull();
    const renderedBefore = renderedEquation!.outerHTML;
    const equation = view.state.doc.firstChild;
    expect(equation?.type.name).toBe("display_math");
    _fixture.stack.use(_fixtureFakeTimers());
    await act(async () => {
      view.dispatch(
        view.state.tr.setNodeMarkup(0, undefined, {
          ...equation!.attrs,
          tex: "\\frac{",
        }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await getScientKatexRuntimePromise();
    });
    expect(
      view.dom.querySelector("[data-scient-markdown-math-source-state='retained']"),
    ).not.toBeNull();
    expect(view.dom.querySelector("[data-scient-markdown-math-validity='invalid']")).not.toBeNull();
    expect(view.dom.querySelector(".scient-markdown-math-render .katex")?.outerHTML).toBe(
      renderedBefore,
    );
    expect(view.dom.querySelector(".scient-markdown-math-retained")?.textContent).toContain(
      "last valid equation",
    );
    expect(controller.session.session.draftSource).toContain("\\frac{");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("renders task, wiki, and raw-source nodes and gates task changes by mode", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: '- [x] Done\n\nSee [[Methods|protocol]].\n\n<section data-x="1">raw</section>\n',
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const checkbox = view.dom.querySelector<HTMLInputElement>(".scient-markdown-task-checkbox");

    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
    expect(checkbox?.getAttribute("aria-label")).toBe("Mark task incomplete: Done");
    expect(view.dom.querySelector("[data-scient-markdown-wiki-link]")?.textContent).toContain(
      "protocol",
    );
    expect(
      view.dom.querySelector(
        "[data-scient-markdown-source-island] .scient-markdown-source-island-code-editor .cm-line",
      )?.textContent,
    ).toContain("raw");

    controller.setMode("write");
    expect(checkbox?.disabled).toBe(false);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(onUserSourceChange.mock.calls[0]?.[0]).toContain("- [ ] Done");
    expect(checkbox?.getAttribute("aria-label")).toBe("Mark task complete: Done");
  });

  it("keeps wiki-link editing out of the document DOM until a picker choice is committed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Method]].\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.stack.use(_fixtureFakeTimers());
    const onOpenWikiLink = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "See [[Methods|protocol]].\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onOpenWikiLink,
      wikiLinkTargetExists: (target) => target === "Methods",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const link = host.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]");
    expect(link?.getAttribute("role")).toBe("link");
    expect(link?.tabIndex).toBe(0);
    expect(link?.dataset.scientMarkdownWikiTargetState).toBe("present");

    link!.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));
    expect(onOpenWikiLink).toHaveBeenCalledExactlyOnceWith("Methods", link);
    controller.setMode("write");
    expect(link?.tabIndex).toBe(-1);
    link!.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));
    expect(onOpenWikiLink).toHaveBeenCalledTimes(1);
    expect(host.querySelector("input")).toBeNull();
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenWikiLink).toHaveBeenCalledTimes(2);

    link!.dispatchEvent(
      new KeyboardEvent("keydown", nativeShortcut({ bubbles: true, key: "Enter" })),
    );
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
    link!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, detail: 1 }),
    );
    expect(view.editable).toBe(true);
    link!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, detail: 2 }),
    );
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
    link!.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenWikiLink).toHaveBeenCalledTimes(3);

    controller.setMode("read");
    const currentLink = host.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]");
    expect(currentLink?.tabIndex).toBe(0);
    currentLink!.dispatchEvent(
      new KeyboardEvent("keydown", nativeShortcut({ bubbles: true, key: "Enter" })),
    );
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.stack.use(_fixtureFakeTimers());
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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a[href]")];
    expect(links).toHaveLength(2);

    links[0]!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }),
    );
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com", links[0]);
    links[1]!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }),
    );
    expect(view.state.selection.$from.parent.type.name).toBe("heading");
    expect(onLocalHeadingOpened).toHaveBeenCalledOnce();
    expect(onUserSourceChange).not.toHaveBeenCalled();

    controller.setMode("write");
    links[0]!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, detail: 1 }),
    );
    expect(onOpenLink).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenLink).toHaveBeenCalledTimes(2);

    links[0]!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, detail: 1 }),
    );
    links[0]!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    );
    links[0]!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, detail: 2 }),
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
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, detail: 1 }),
    );
    await vi.advanceTimersByTimeAsync(220);
    expect(onOpenLink).toHaveBeenCalledTimes(2);

    links[0]!.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, ctrlKey: true }),
    );
    expect(onOpenLink).toHaveBeenCalledTimes(3);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("opens a GFM bare URL recognized by the established preview", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onOpenLink = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Source: https://example.com/reference.\n",
      revision: "sha256:before",
      mode: "read",
      ariaLabel: "Markdown document",
      onOpenLink,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    controller.mount(host);
    const link = host.querySelector<HTMLAnchorElement>("a[href]");

    expect(link?.href).toBe("https://example.com/reference");
    link?.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com/reference", link);
  });

  it("reports a missing same-document heading through the clicked link without mutating", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const view = controller.mount(host);
    const link = view.dom.querySelector<HTMLAnchorElement>("a[href='#not-here']")!;
    const sourceBefore = controller.session.session.draftSource;

    link.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }));

    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("#not-here", link);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(sourceBefore);
  });

  it.each(["```text\noriginal\n```\n", "<div>original</div>\n"])(
    "uses document history for embedded source without recording undo as an edit: %s",
    async (source) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const controller = new ScientMarkdownEditorView({
        source,
        revision: "r1",
        mode: "write",
        ariaLabel: "History test",
      });
      const host = document.createElement("div");
      document.body.append(_ownDOM(_fixture, host));
      _fixture.mounted.push(controller);
      const outer = controller.mount(host);
      const surface = host.querySelector<HTMLElement>(".cm-editor")!;
      const nested = CodeMirrorEditorView.findFromDOM(surface)!;
      nested.dispatch({ changes: { from: 0, insert: "changed " } });
      const changed = controller.session.session.draftSource;
      expect(changed).not.toBe(source);
      controller.setMode("read");
      nested.contentDOM.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          nativeShortcut({ key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
        ),
      );
      expect(controller.session.session.draftSource).toBe(changed);
      controller.setMode("write");
      _fixture.stack.use(_fixtureFakeTimers({ toFake: ["Date"] }));
      vi.setSystemTime(Date.now() + 1000);
      nested.contentDOM.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          nativeShortcut({ key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
        ),
      );
      expect(controller.session.session.draftSource).toBe(source);
      expect(controller.execute("undo")).toBe(false);
      expect(controller.execute("redo")).toBe(true);
      expect(controller.session.session.draftSource).toBe(changed);
      expect(host.querySelector(".cm-editor")).toBe(surface);
      expect(nested.state.doc.toString()).toBe(
        outer.state.doc.firstChild?.type.name === "raw_block"
          ? outer.state.doc.firstChild.attrs.source
          : outer.state.doc.firstChild?.textContent,
      );
    },
  );

  it("keeps one plain-code surface across selection, appearance, and mode changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "```python linenos\nprint('result')\n```\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const rendered = view.dom.querySelector<HTMLElement>(".scient-markdown-code-render");
    const editor = view.dom.querySelector<HTMLElement>(".scient-markdown-code-editor .cm-editor");
    const content = view.dom.querySelector<HTMLElement>(".scient-markdown-code-editor .cm-content");

    expect(rendered?.textContent).toContain("print('result')");
    expect(rendered?.hidden).toBe(true);
    expect(editor).not.toBeNull();
    expect(content?.getAttribute("contenteditable")).toBe("true");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).toBe(editor);
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
    controller.refreshExternalPresentation("appearance");
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
    controller.setMode("read");
    expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).toBe(editor);
    expect(content?.getAttribute("contenteditable")).toBe("false");
    controller.setMode("write");
    expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).toBe(editor);
    expect(content?.getAttribute("contenteditable")).toBe("true");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("keeps a rich visual interactive and opens source only through an authoring action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: '```plotly\n{"data":[{"x":[1],"y":[2]}]}\n```\n',
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange: vi.fn(),
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    let view!: EditorView;
    await act(() => {
      view = controller.mount(host);
    });
    host.scrollIntoView({ block: "center" });
    const preview = await vi.waitFor(() => {
      const preview = view.dom.querySelector("[data-scient-rich-fence-validity='valid']");
      expect(preview).not.toBeNull();
      return preview!;
    });
    const codeBlock = view.state.doc.firstChild;
    expect(codeBlock?.type.name).toBe("code_block");
    // Flush the NodeView's React root and async validation together. A DOM
    // polling deadline can expire before React commits on a busy CI runner.
    await act(() => {
      view.dispatch(
        view.state.tr.replaceWith(1, codeBlock!.nodeSize - 1, view.state.schema.text('{"data":[')),
      );
    });
    const retained = view.dom.querySelector("[data-scient-rich-fence-source-state='retained']");
    expect(retained).toBe(preview);
    expect(retained?.getAttribute("data-scient-rich-fence-validity")).toBe("invalid");
    expect(retained?.textContent).toContain("Preview kept at the last valid version.");
    expect(view.state.doc.firstChild?.textContent).toBe('{"data":[');
  });

  it("inserts an uploaded image only after the server returns its portable path", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("drops a pending image insertion when the editor becomes read-only", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let resolveUpload!: (value: { readonly src: string; readonly alt: string }) => void;
    const uploadPromise = new Promise<{ readonly src: string; readonly alt: string }>((resolve) => {
      resolveUpload = resolve;
    });
    const source = "Before image.\n";
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Pending image upload",
      uploadImage: () => uploadPromise,
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    expect(controller.uploadImageFile(new File(["image"], "plot.png", { type: "image/png" }))).toBe(
      true,
    );
    expect(view.dom.querySelector("[data-scient-markdown-image-upload]")).not.toBeNull();

    controller.setMode("read");
    resolveUpload({ src: "assets/plot.png", alt: "Plot" });
    await uploadPromise;
    expect(view.dom.querySelector("[data-scient-markdown-image-upload]")).toBeNull();
    expect(view.dom.querySelector("[data-scient-markdown-image]")).toBeNull();
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    controller.setMode("write");
    expect(controller.session.session.draftSource).toBe(source);
  });

  it("does not insert a pending upload into an adopted replacement document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let resolveUpload!: (value: { readonly src: string; readonly alt: string }) => void;
    const uploadPromise = new Promise<{ readonly src: string; readonly alt: string }>((resolve) => {
      resolveUpload = resolve;
    });
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Original document.\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Pending image upload",
      uploadImage: () => uploadPromise,
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    controller.uploadImageFile(new File(["image"], "plot.png", { type: "image/png" }));
    const source = "Replacement document.\n";
    expect(controller.receiveExternalSource({ source, revision: "r1" })).toBe("adopted");

    resolveUpload({ src: "assets/plot.png", alt: "Plot" });
    await uploadPromise;
    expect(view.dom.querySelector("[data-scient-markdown-image-upload]")).toBeNull();
    expect(view.dom.querySelector("[data-scient-markdown-image]")).toBeNull();
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("finds rich text across formatting boundaries without producing a save", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "alpha Alpha alphabet al**pha**\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);

    const shortcut = new KeyboardEvent(
      "keydown",
      nativeShortcut({
        key: "f",
        ctrlKey: true,
        cancelable: true,
      }),
    );
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

  it("replaces the current or every rich-view match as one user edit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "alpha and alpha\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("builds a nested document outline and navigates without saving", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Intro\n\nText\n\n> ## Nested methods\n> Body\n\n### Results\n",
      revision: "sha256:before",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("moves, duplicates, deletes, and undoes source-faithful top-level blocks", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# One\n\n__two__\n\n-   three\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("moves a multi-block selection as one structural edit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "One\n\n__Two__\n\n-   Three\n\nFour\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("pins leading front matter while leaving explicit deletion available", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = "---\ntitle: Safe\n---\n\n# Heading\n\nBody\n";
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("deletes the only block into an editable empty paragraph", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Only block\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);

    expect(controller.executeBlock("delete")).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(controller.session.session.draftSource).toBe("\n");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("runs formatting and slash commands through user transactions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Text\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it("implements the inline-code and strikethrough shortcuts advertised by the dock", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "Some text here.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 10)));

    for (const event of [
      new KeyboardEvent("keydown", nativeShortcut({ key: "e", ctrlKey: true })),
      new KeyboardEvent("keydown", nativeShortcut({ key: "x", ctrlKey: true, shiftKey: true })),
    ]) {
      expect(view.someProp("handleKeyDown", (handler) => handler(view, event))).toBe(true);
    }
    const active = new Set(controller.getSnapshot().activeMarks);
    expect(active).toEqual(new Set(["code", "strike"]));
    expect(controller.session.session.draftSource).toBe("Some ~~`text`~~ here.\n");
  });

  it.each([
    ["bold", "b", false, "strong"],
    ["italic", "i", false, "em"],
    ["inline code", "e", false, "code"],
    ["strikethrough", "x", true, "strike"],
  ] as const)(
    "toggles %s from a real DOM shortcut as one undoable command",
    async (_name, key, shiftKey, mark) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const controller = new ScientMarkdownEditorView({
        source: "Text\n",
        revision: "sha256:before",
        mode: "write",
        ariaLabel: "Mark shortcut",
      });
      const host = document.createElement("div");
      document.body.append(_ownDOM(_fixture, host));
      _fixture.mounted.push(controller);
      const view = controller.mount(host);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
      const press = () => {
        const event = new KeyboardEvent(
          "keydown",
          nativeShortcut({
            key,
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            shiftKey,
          }),
        );
        view.dom.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      };

      press();
      expect(controller.getSnapshot().activeMarks).toContain(mark);
      const undo = new KeyboardEvent(
        "keydown",
        nativeShortcut({
          key: "z",
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      );
      view.dom.dispatchEvent(undo);
      expect(undo.defaultPrevented).toBe(true);
      expect(controller.session.session.draftSource).toBe("Text\n");
    },
  );

  it("routes real DOM selection, formatting, and history shortcuts exactly once", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Some text here.\n\nSecond paragraph.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Shortcut document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const dispatchShortcut = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent(
        "keydown",
        nativeShortcut({
          key,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          ...init,
        }),
      );
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

  it("routes familiar style, list, and clear-formatting keys through toolbar commands", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "Text\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Structural shortcuts",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const dispatchShortcut = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent(
        "keydown",
        nativeShortcut({
          key,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          ...init,
        }),
      );
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
    const hebrewLayoutBold = new KeyboardEvent(
      "keydown",
      nativeShortcut({
        key: "נ",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
    Object.defineProperty(hebrewLayoutBold, "keyCode", { value: 66 });
    view.dom.dispatchEvent(hebrewLayoutBold);
    expect(hebrewLayoutBold.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe("**Text**\n");
  });

  it("covers every advertised heading, list, hard-break, and block-action chord", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "First\n\nSecond\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Command shortcut matrix",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent(
        "keydown",
        nativeShortcut({
          key,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          ...init,
        }),
      );
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

  it("uses identical code-block exit semantics for hard-break commands and shortcuts", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = "```ts\nconst value = 1;\n```\n";
    const run = (shortcut: boolean) => {
      const controller = new ScientMarkdownEditorView({
        source,
        revision: "sha256:before",
        mode: "write",
        ariaLabel: shortcut ? "Shortcut hard break" : "Command hard break",
      });
      const host = document.createElement("div");
      document.body.append(_ownDOM(_fixture, host));
      _fixture.mounted.push(controller);
      const view = controller.mount(host);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));

      if (shortcut) {
        const event = new KeyboardEvent(
          "keydown",
          nativeShortcut({
            key: "Enter",
            bubbles: true,
            cancelable: true,
            shiftKey: true,
          }),
        );
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

  it("moves the caret into a keyboard-selected citation on Enter and back out on Escape", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = "Evidence [@smith2020] here.\n";
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Citation keyboard entry",
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    let citationPosition = -1;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "citation") citationPosition = position;
    });
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, citationPosition)),
    );
    const field = view.dom.querySelector<HTMLInputElement>(
      '[data-scient-markdown-reference="citation"] input',
    )!;
    expect(document.activeElement).not.toBe(field);

    const enter = new KeyboardEvent(
      "keydown",
      nativeShortcut({ key: "Enter", bubbles: true, cancelable: true }),
    );
    view.dom.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(controller.session.session.draftSource).toBe(source);

    field.dispatchEvent(
      new KeyboardEvent("keydown", nativeShortcut({ key: "Escape", bubbles: true })),
    );
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(citationPosition + 1);
    expect(controller.session.session.draftSource).toBe(source);

    controller.setMode("read");
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, citationPosition)),
    );
    const readEnter = new KeyboardEvent(
      "keydown",
      nativeShortcut({
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    view.dom.dispatchEvent(readEnter);
    expect(readEnter.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(field);
  });

  it("leaves native clipboard shortcuts native and matches editor UI keys exactly", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Clipboard text.\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Clipboard shortcuts",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 10)));

    for (const [key, shiftKey] of [
      ["c", false],
      ["x", false],
      ["v", false],
      ["v", true],
    ] as const) {
      const event = new KeyboardEvent(
        "keydown",
        nativeShortcut({
          key,
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          shiftKey,
        }),
      );
      view.dom.dispatchEvent(event);
      expect(event.defaultPrevented, `${key} must remain native`).toBe(false);
    }
    expect(controller.session.session.draftSource).toBe("Clipboard text.\n");
    expect(onUserSourceChange).not.toHaveBeenCalled();

    const shiftedFind = new KeyboardEvent(
      "keydown",
      nativeShortcut({
        key: "f",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        shiftKey: true,
      }),
    );
    view.dom.dispatchEvent(shiftedFind);
    expect(shiftedFind.defaultPrevented).toBe(false);
    expect(controller.getSnapshot().findOpen).toBe(false);
  });

  it("applies GFM alignment to the complete selected table column", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "| Group | Value |\n| --- | --- |\n| A | 2.4 |\n| B | 4.8 |\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
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

  it.each([
    "![Plot](plot.png)\n",
    "Before.\n\n```ts\nconst sample = 1;\n```\n\n![Plot](plot.png)\n",
    "# Heading\n\n- Item\n\n  ```ts\n  const sample = 1;\n  ```\n\n| Image |\n| --- |\n| ![Plot](plot.png) |\n",
    "Before ![Plot](plot.png) after.\n",
    "[![Plot](plot.png)](https://example.test)\n",
    "| Image |\n| --- |\n| ![Plot](plot.png) |\n",
  ])("expands an image directly without editing its authored context: %s", async (source) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Image expansion",
      resolveImageSource: () => nativeImageUrl("plot.png"),
      onUserSourceChange,
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    let view!: EditorView;
    await act(() => {
      view = controller.mount(host);
    });
    await act(() => completeImageLoad(host.querySelector("img")!));
    const expand = host.querySelector<HTMLButtonElement>("[aria-label='Expand image']")!;
    expect(expand).not.toBeNull();
    await act(() => expand.click());
    // Process the modal's accessibility mutations at the editor's observer
    // checkpoint, including records not yet delivered by MutationObserver.
    await act(() => {
      (view as EditorView & { domObserver: { flush: () => void } }).domObserver.flush();
    });
    expect(host.querySelector("[aria-label='Expand image']")).toBe(expand);
    expect(
      document.querySelector("[role='dialog'] [data-preview-image-surface] img"),
    ).not.toBeNull();
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    await act(() => {
      document
        .querySelector<HTMLButtonElement>("[role='dialog'] button[aria-label='Close']")!
        .click();
    });
    await act(() => {
      (view as EditorView & { domObserver: { flush: () => void } }).domObserver.flush();
    });
    expect(host.querySelector("[aria-label='Expand image']")).toBe(expand);
    await act(() => expand.click());
    await act(() => {
      (view as EditorView & { domObserver: { flush: () => void } }).domObserver.flush();
    });
    expect(
      document.querySelector("[role='dialog'] [data-preview-image-surface] img"),
    ).not.toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("edits the visible image caption repeatedly without hiding it or reloading the image", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const resolveImageSource = vi.fn(async (source: string) => nativeImageUrl(source));
    const controller = new ScientMarkdownEditorView({
      source: '![Microscopy image](figures/cell.png "Cell culture")\n',
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
      resolveImageSource,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const image = view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render");

    await vi.waitFor(() => expect(image?.src).toContain("figures/cell.png"));
    await completeImageLoad(image!);
    expect(image?.alt).toBe("Microscopy image");
    const caption = view.dom.querySelector<HTMLTextAreaElement>("[aria-label='Image caption']")!;
    expect(caption.value).toBe("Cell culture");
    expect(resolveImageSource).toHaveBeenCalledWith("figures/cell.png");
    image!.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
    );
    expect(document.querySelector("[aria-label='Image source']")).toBeNull();
    expect(image?.hidden).toBe(false);
    expect(document.activeElement).toBe(caption);
    expect(caption.selectionStart).toBe(caption.value.length);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    for (const value of ["Updated caption", "Updated caption again"]) {
      caption.value = value;
      caption.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      expect(controller.session.session.draftSource).toContain(`"${value}"`);
      expect(view.dom.querySelector("[aria-label='Image caption']")).toBe(caption);
      expect(caption.hidden).toBe(false);
      expect(document.activeElement).toBe(caption);
    }
    expect(image?.hidden).toBe(false);
    expect(resolveImageSource).toHaveBeenCalledOnce();
    expect(onUserSourceChange).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Add caption", "![Plot](plot.png)\n"],
    ["Edit caption", '![Plot](plot.png "Existing caption")\n'],
  ])("keeps caption focus after choosing %s from the real image menu", async (label, source) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Image caption menu",
      onUserSourceChange,
      resolveImageSource: async () => nativeImageUrl("plot.png"),
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    let view!: EditorView;
    await act(() => {
      view = controller.mount(host);
    });
    const image = view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render")!;
    await act(() => completeImageLoad(image));
    await act(() =>
      image.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
      ),
    );
    const caption = view.dom.querySelector<HTMLTextAreaElement>("[aria-label='Image caption']")!;
    const more = view.dom.querySelector<HTMLButtonElement>(
      "button[aria-label='More image actions']",
    )!;
    await act(() => {
      more.focus();
      more.click();
    });
    const item = await openMenuItem(label);
    await page.elementLocator(item).click();
    await expect.poll(() => caption.hidden).toBe(false);
    await expect.poll(() => document.activeElement).toBe(caption);
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    await act(() => {
      caption.value = "New caption כיתוב";
      caption.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    expect(document.activeElement).toBe(caption);
    expect(view.dom.querySelector("[aria-label='Image caption']")).toBe(caption);
    expect(controller.session.session.draftSource).toBe('![Plot](plot.png "New caption כיתוב")\n');
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    await act(() =>
      caption.dispatchEvent(
        new KeyboardEvent("keydown", nativeShortcut({ key: "Enter", bubbles: true })),
      ),
    );
    expect(caption.hidden).toBe(false);
    expect(controller.session.session.draftSource).toBe('![Plot](plot.png "New caption כיתוב")\n');
    await act(() => controller.execute("undo"));
    expect(controller.session.session.draftSource).toBe(source);
    expect(view.dom.querySelector(".scient-markdown-image-render")).toBe(image);
  });

  it("uses real image viewing controls without creating Markdown edits or saves", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = '![Plot](plot.png "Caption")\n';
    const onUserSourceChange = vi.fn();
    const resolveImageSource = vi
      .fn()
      .mockResolvedValueOnce(nativeImageUrl("plot-inline.png"))
      .mockResolvedValueOnce(nativeImageUrl("plot-viewer.png"))
      .mockResolvedValueOnce(nativeImageUrl("plot-viewer-refreshed.png"));
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Image viewing actions",
      onUserSourceChange,
      resolveImageSource,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    let view!: EditorView;
    await act(() => {
      view = controller.mount(host);
    });
    const image = view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render")!;
    await act(() => completeImageLoad(image));
    await act(() => {
      image.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
      );
    });
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    const toolbar = view.dom.querySelector<HTMLElement>(
      "[role='group'][aria-label='Image actions']",
    )!;
    const card = toolbar.closest<HTMLElement>("[data-scient-visual-card]")!;
    expect(card).not.toBeNull();
    card.style.cssText = "position: fixed; left: 100px; top: 100px; width: 400px; height: 300px";
    toolbar.closest<HTMLElement>("[data-scient-image-controls]")!.style.cssText =
      "position: absolute; inset: 0";
    toolbar.style.cssText = "position: absolute; left: 4px; top: 4px; width: 100px; height: 32px";
    expect(card.getBoundingClientRect().toJSON()).toEqual(new DOMRect(100, 100, 400, 300).toJSON());
    const moveHandle = toolbar.querySelector<HTMLButtonElement>(
      "button[aria-label='Move image actions']",
    )!;
    const focusReceipt = _fixture.stack.use(vi.spyOn(moveHandle, "focus"));
    expect(moveHandle.hidden).toBe(true);
    await page
      .elementLocator(
        toolbar.querySelector<HTMLButtonElement>("[aria-label='More image actions']")!,
      )
      .click();
    await page.getByRole("menuitem", { name: "Move controls", exact: true }).click();
    expect(moveHandle.isConnected).toBe(true);
    expect(moveHandle.hidden).toBe(false);
    expect(moveHandle.getClientRects().length).toBeGreaterThan(0);
    await expect.poll(() => focusReceipt.mock.calls.length).toBeGreaterThan(0);
    await expect.poll(() => document.activeElement).toBe(moveHandle);
    const toolbarOrigin = toolbar.getBoundingClientRect();
    for (const [key, shiftKey, translation, x, y] of [
      ["ArrowRight", false, "10px", 10, 0],
      ["ArrowDown", true, "10px 1px", 10, 1],
      ["Home", false, "", 0, 0],
    ] as const) {
      const event = new KeyboardEvent(
        "keydown",
        nativeShortcut({
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
      await act(() => {
        moveHandle.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(toolbar.style.translate).toBe(translation);
      expect(toolbar.getBoundingClientRect().left).toBeCloseTo(toolbarOrigin.left + x);
      expect(toolbar.getBoundingClientRect().top).toBeCloseTo(toolbarOrigin.top + y);
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
    }
    await act(() =>
      moveHandle.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          nativeShortcut({ key: "Enter", bubbles: true, cancelable: true }),
        ),
      ),
    );
    const more = view.dom.querySelector<HTMLButtonElement>(
      "button[aria-label='More image actions']",
    )!;
    await page.elementLocator(more).click();
    const background = await openMenuItem("Background: automatic");
    await page.elementLocator(background).click();
    expect(image.style.backgroundColor).toBe("white");

    await page
      .elementLocator(
        view.dom.querySelector<HTMLButtonElement>("button[aria-label='Expand image']")!,
      )
      .click();
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector<HTMLImageElement>("[data-preview-image-surface] img")!.src).toBe(
      nativeImageUrl("plot-viewer.png"),
    );
    expect(image.src).toBe(nativeImageUrl("plot-inline.png"));
    await page
      .elementLocator(
        dialog.querySelector<HTMLButtonElement>("button[aria-label='More image actions']")!,
      )
      .click();
    const refresh = await openMenuItem("Refresh image");
    await page.elementLocator(refresh).click();
    expect(resolveImageSource).toHaveBeenCalledTimes(3);
    expect(
      document.querySelector<HTMLImageElement>("[role='dialog'] [data-preview-image-surface] img")!
        .src,
    ).toBe(nativeImageUrl("plot-viewer-refreshed.png"));
    expect(image.src).toBe(nativeImageUrl("plot-inline.png"));
    await act(() =>
      document
        .querySelector<HTMLButtonElement>("[role='dialog'] button[aria-label='Close']")!
        .click(),
    );
    expect(document.querySelector("[role='dialog'][data-open]")).toBeNull();
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.execute("undo")).toBe(false);
  });

  it("resolves repeated references to one workspace image independently", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const resolveImageSource = vi.fn(async () => nativeImageUrl("shared.png"));
    const controller = new ScientMarkdownEditorView({
      source: "![First](./shared.png)\n\n![Second](./shared.png)\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Repeated images",
      resolveImageSource,
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const view = controller.mount(host);

    await vi.waitFor(() => {
      const images = [
        ...view.dom.querySelectorAll<HTMLImageElement>(".scient-markdown-image-render"),
      ];
      expect(images).toHaveLength(2);
      expect(images.every((image) => image.src === nativeImageUrl("shared.png"))).toBe(true);
    });
    expect(resolveImageSource).toHaveBeenCalledTimes(2);
    expect(resolveImageSource).toHaveBeenNthCalledWith(1, "./shared.png");
    expect(resolveImageSource).toHaveBeenNthCalledWith(2, "./shared.png");
  });

  it("refreshes missing workspace images and wiki targets without changing the document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let resourcesAvailable = false;
    const onUserSourceChange = vi.fn();
    const resolveImageSource = vi.fn(async () =>
      resourcesAvailable ? nativeImageUrl("created.png") : null,
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
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const view = controller.mount(host);
    const image = view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render")!;
    const placeholder = view.dom.querySelector<HTMLElement>(".scient-markdown-image-placeholder")!;
    const wikiLink = view.dom.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]")!;

    await vi.waitFor(() => expect(placeholder.textContent).toBe("Image unavailable"));
    expect(wikiLink.dataset.scientMarkdownWikiTargetState).toBe("missing");

    resourcesAvailable = true;
    controller.refreshExternalPresentation("workspace");

    await vi.waitFor(() => expect(image.src).toBe(nativeImageUrl("created.png")));
    await completeImageLoad(image);
    expect(image.hidden).toBe(false);
    expect(wikiLink.dataset.scientMarkdownWikiTargetState).toBe("present");
    expect(resolveImageSource).toHaveBeenCalledTimes(2);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(
      "![Created later](figures/created.png)\n\nSee [[Created later]].\n",
    );
  });

  it("clears stale image state when an unresolved path is removed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "![Missing](figures/missing.png)\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      resolveImageSource: vi.fn(async () => null),
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const placeholder = view.dom.querySelector<HTMLElement>(".scient-markdown-image-placeholder");

    await vi.waitFor(() => expect(placeholder?.textContent).toBe("Image unavailable"));
    const source = await openImageDetails(view);
    await changeImageDetail(source, "");
    await applyImageDetails(source);

    expect(placeholder?.textContent).toBe("Choose an image source");
    expect(placeholder?.hidden).toBe(false);
    expect(view.dom.querySelector<HTMLImageElement>(".scient-markdown-image-render")?.hidden).toBe(
      true,
    );
  });

  it("keeps alt edits local and detaches an image only after Make independent and Apply", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const controller = new ScientMarkdownEditorView({
      source: "![Plot][figure]\n\n[figure]: old.png\n",
      revision: "r0",
      mode: "write",
      ariaLabel: "Reference image",
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const view = controller.mount(host);
    const source = await openImageDetails(view);
    expect(source.readOnly).toBe(true);
    const alt = document.querySelector<HTMLInputElement>("[aria-label='Image alt text']")!;
    await changeImageDetail(alt, "New description");
    expect(controller.session.session.draftSource).toContain("![Plot][figure]");
    await applyImageDetails(source);
    expect(controller.session.session.draftSource).toContain("![New description][figure]");
    for (const value of ["chosen.png", "old.png"]) {
      const path = await openImageDetails(view);
      if (value === "chosen.png") {
        const independent = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Make independent",
        )!;
        await act(() => independent.click());
        expect(path.readOnly).toBe(false);
        expect(view.state.doc.firstChild!.firstChild!.attrs.referenceLabel).toBe("figure");
      }
      await changeImageDetail(path, value);
      await applyImageDetails(path);
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

  it("opens image details with Enter and cancels a draft without saving", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = "![Plot](plot.png)\n";
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Keyboard image details",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    expect(document.querySelector("[aria-label='Image source']")).toBeNull();

    const input = await openImageDetails(view);
    await expect.element(input).toHaveFocus();
    await changeImageDetail(input, "different.png");
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    const cancel = [...input.closest("form")!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Cancel",
    )!;
    await act(() => cancel.click());
    expect(document.querySelector("[aria-label='Image source']")).toBeNull();
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("invalidates open image details when a source reload reuses an equal image", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = '![Plot](plot.png "Caption")\n\nOriginal text.\n';
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Reload image target",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const image = view.dom.querySelector("[data-scient-markdown-image]")!;
    const caption = view.dom.querySelector<HTMLTextAreaElement>("[aria-label='Image caption']")!;
    const input = await openImageDetails(view);
    await changeImageDetail(input, "stale-draft.png");
    const form = input.closest("form")!;
    const replacement = source.replace("Original text.", "Externally changed text.");

    await act(() => {
      expect(controller.receiveExternalSource({ source: replacement, revision: "r1" })).toBe(
        "adopted",
      );
    });
    expect(view.dom.querySelector("[data-scient-markdown-image]")).toBe(image);
    expect(document.querySelector("[aria-label='Image source']")).toBeNull();
    expect(caption.hidden).toBe(false);
    expect(caption.value).toBe("Caption");
    await act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(controller.session.session.draftSource).toBe(replacement);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("focuses the active image reference definition without saving the document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = '![Plot][figure]\n\n[figure]: plot.png "Caption"\n\n[FIGURE]: ignored.png\n';
    const onUserSourceChange = vi.fn();
    const onOpenSourceLine = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Image reference definition",
      onUserSourceChange,
      onOpenSourceLine,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const definition = view.dom.querySelector<HTMLTextAreaElement>(
      ".scient-markdown-source-island-editor",
    )!;

    expect(controller.editImageReference("FIGURE")).toBe(true);
    expect(document.activeElement).toBe(definition);
    expect(definition.value).toBe('[figure]: plot.png "Caption"');
    expect(definition.selectionStart).toBe(0);
    expect(definition.selectionEnd).toBe(0);
    expect(onOpenSourceLine).not.toHaveBeenCalled();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(source);
  });

  it("reveals a nested winning image definition in source without changing the rich document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source =
      "![Plot][figure]\n\n> Intro\n>\n> [figure]: winning.png\n\n[FIGURE]: ignored.png\n";
    const onUserSourceChange = vi.fn();
    const onOpenSourceLine = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Nested image reference definition",
      onUserSourceChange,
      onOpenSourceLine,
    });
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    _fixture.mounted.push(controller);
    const view = controller.mount(host);
    const selection = view.state.selection;

    expect(controller.editImageReference("figure")).toBe(true);
    expect(onOpenSourceLine).toHaveBeenCalledExactlyOnceWith(5);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(source);
    expect(controller.editImageReference("missing")).toBe(false);
    controller.setMode("read");
    expect(controller.editImageReference("figure")).toBe(false);
    expect(onOpenSourceLine).toHaveBeenCalledOnce();
  });

  it("navigates from a numbered marker without focusing the directly editable definition", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = "Note[^lab].\n\n[^lab]: Collected twice.\n";
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Footnote reference",
      onUserSourceChange,
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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

    editor.dispatchEvent(
      new KeyboardEvent("keydown", nativeShortcut({ bubbles: true, key: "Escape" })),
    );
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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

  it("directly edits a compact reference definition and refreshes its derived link", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const source = 'Read [the source][shared].\n\n[shared]: ./old.md "Old title"\n';
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Reference definition",
      onUserSourceChange,
    });
    _fixture.mounted.push(controller);
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
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

    editor.dispatchEvent(
      new KeyboardEvent("keydown", nativeShortcut({ bubbles: true, key: "Escape" })),
    );
    expect(editor.hidden).toBe(false);
    expect(controller.session.session.draftSource).toContain('[shared]: ./new.md "New title"');
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    mounted: [] as ScientMarkdownEditorView[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
