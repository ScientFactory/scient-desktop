// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownSourceView } from "./ScientMarkdownSourceView";

describe("ScientMarkdownSourceView", () => {
  const mounted: ScientMarkdownSourceView[] = [];

  afterEach(() => {
    mounted.splice(0).forEach((controller) => controller.destroy());
    document.body.replaceChildren();
  });

  function mountSource() {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownSourceView({
      source: "# Source\n",
      editable: true,
      ariaLabel: "Markdown source",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    const view = controller.mount(host);
    return { controller, host, onUserSourceChange, view };
  }

  it("keeps one CodeMirror view while editability changes", () => {
    const { controller, view } = mountSource();
    controller.setEditable(false);
    controller.setEditable(true);
    expect(controller.view).toBe(view);
    expect(controller.source).toBe("# Source\n");
  });

  it("does not report an external replacement as a user edit", () => {
    const { controller, onUserSourceChange, view } = mountSource();
    controller.replaceExternalSource("# Agent source\n");
    expect(view.state.doc.toString()).toBe("# Agent source\n");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("reports a real source edit", () => {
    const { onUserSourceChange, view } = mountSource();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "Text\n" } });
    expect(onUserSourceChange).toHaveBeenCalledWith("# Source\nText\n");
  });
});
