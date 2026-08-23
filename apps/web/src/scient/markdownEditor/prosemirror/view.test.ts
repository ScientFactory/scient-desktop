// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NodeSelection, TextSelection } from "prosemirror-state";

import { ScientMarkdownEditorView } from "./view";

describe("ScientMarkdownEditorView", () => {
  const mounted: ScientMarkdownEditorView[] = [];

  afterEach(() => {
    mounted.splice(0).forEach((controller) => controller.destroy());
    document.body.replaceChildren();
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

  it("keeps rendered math visible while the rich document is editable", async () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "Energy is $E=mc^2$.\n\n$$\n\\int_0^1 x \\, dx\n$$\n",
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
    expect(view.dom.querySelectorAll("[data-scient-markdown-math]")).toHaveLength(2);
    await vi.waitFor(() => {
      expect(view.dom.querySelector("[data-scient-markdown-math='inline']")?.textContent).toContain(
        "E=mc^2",
      );
      expect(
        view.dom.querySelector("[data-scient-markdown-math='display']")?.textContent,
      ).toContain("\\int_0^1 x \\, dx");
    });
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
    expect(view.dom.querySelector("[data-scient-markdown-wiki-link]")?.textContent).toContain(
      "protocol",
    );
    expect(view.dom.querySelector("[data-scient-markdown-source-island]")?.textContent).toContain(
      "raw",
    );

    controller.setMode("write");
    expect(checkbox?.disabled).toBe(false);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(onUserSourceChange.mock.calls[0]?.[0]).toContain("- [ ] Done");
  });

  it("keeps a rendered code block visible when its nested editor activates", async () => {
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
    expect(rendered?.hidden).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("keeps a rendered scientific diagram visible beside its nested source editor", async () => {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "```mermaid title=Flow\ngraph LR\n  A --> B\n```\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);

    await vi.waitFor(() => {
      expect(view.dom.querySelector("[data-scient-markdown-rich-fence='mermaid']")).not.toBeNull();
      expect(view.dom.querySelector(".scient-mermaid-card")).not.toBeNull();
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    await vi.waitFor(() => {
      expect(view.dom.querySelector(".scient-markdown-code-editor .cm-editor")).not.toBeNull();
    });
    expect(view.dom.querySelector(".scient-mermaid-card")).not.toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("retains the last valid scientific preview during invalid source edits", async () => {
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
      metaKey: true,
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

  it("keeps a workspace image rendered while its portable source fields are edited", async () => {
    const onUserSourceChange = vi.fn();
    const resolveImageSource = vi.fn(async (source: string) => `https://asset.test/${source}`);
    const controller = new ScientMarkdownEditorView({
      source: "![Microscopy image](figures/cell.png)\n",
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
    expect(resolveImageSource).toHaveBeenCalledWith("figures/cell.png");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    expect(view.dom.querySelector<HTMLInputElement>("[aria-label='Image path']")?.value).toBe(
      "figures/cell.png",
    );
    expect(image?.hidden).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });
});
