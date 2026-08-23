// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
    const { controller, onUserSourceChange, view } = mountEditor();
    const documentNode = view.state.doc;

    for (let index = 0; index < 100; index += 1) {
      controller.setMode("write");
      expect(view.editable).toBe(true);
      controller.setMode("read");
      expect(view.editable).toBe(false);
    }

    expect(controller.view).toBe(view);
    expect(view.state.doc).toBe(documentNode);
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
});
