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
